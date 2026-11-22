const SOURCE = 'https://cal.syoboi.jp';
const CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 19, 72, 100, 187];
const DAY = 86400000;
const ANIME_CATEGORIES = new Set([1, 7, 10]);
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });

export function jstDate(time) {
  return dayFormat.format(time);
}

export function calendarRange(time) {
  const today = Date.parse(jstDate(time) + 'T00:00:00+09:00');
  return { start: today - 7 * DAY, end: today + 2 * DAY };
}

export function normalizeSchedule(programs, titles, start, end) {
  return programs.flatMap(program => {
    const title = titles[program.TID];
    const startsAt = Number(program.StTime) * 1000;
    const endsAt = Number(program.EdTime) * 1000;
    const pid = Number(program.PID);
    const tid = Number(program.TID);
    const count = Number(program.Count);
    const episode = Number.isSafeInteger(count) && count > 0 ? count : null;
    if (!ANIME_CATEGORIES.has(Number(title?.Cat)) || !title?.Title ||
        !CHANNELS.includes(Number(program.ChID)) || !Number.isSafeInteger(pid) || pid <= 0 ||
        !Number.isSafeInteger(tid) || tid <= 0 || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) ||
        startsAt < start || startsAt >= end || endsAt <= startsAt) return [];

    return [{
      pid, tid, episode, startsAt, endsAt,
      id: episode ? `${tid}-e${episode}` : `${tid}-p${pid}`,
      title: title.Title,
      subtitle: program.SubTitle2 || '',
      channel: program.ChName
    }];
  }).sort((a, b) => a.startsAt - b.startsAt || a.pid - b.pid);
}

export function readSnapshot(row) {
  if (!row) return { airings: [], season: null };
  const data = JSON.parse(row.airings);
  return Array.isArray(data) ? { airings: data, season: null } : data;
}

export function seasonKey(time) {
  const [year, month] = jstDate(time).split('-').map(Number);
  return year + '-' + Math.floor((month - 1) / 3);
}

function titleMonth(year, month) {
  return Number(year) > 0 && Number(month) >= 1 && Number(month) <= 12
    ? Number(year) * 12 + Number(month) - 1
    : null;
}

function isSeasonTitle(title, seasonMonth) {
  const category = Number(title.Cat);
  const first = titleMonth(title.FirstYear, title.FirstMonth);
  const last = titleMonth(title.FirstEndYear, title.FirstEndMonth);
  return (first === null || first < seasonMonth + 3) &&
    (last === null ? category === 1 : last >= seasonMonth && (category === 1 || category === 10));
}

function buildSeason(airings, titles, previous, now) {
  const key = seasonKey(now);
  const [year, quarter] = key.split('-').map(Number);
  const startsAt = Date.parse(`${year}-${String(quarter * 3 + 1).padStart(2, '0')}-01T00:00:00+09:00`);
  const nextQuarter = new Date(Date.UTC(year, quarter * 3 + 3, 1));
  const endsAt = Date.parse(nextQuarter.toISOString().slice(0, 10) + 'T00:00:00+09:00');
  const shows = new Map(previous?.key === key ? previous.shows.map(show => [show.tid, show]) : []);
  const current = new Map();

  for (const airing of airings) {
    if (airing.startsAt < startsAt || airing.startsAt >= endsAt) continue;
    if (!isSeasonTitle(titles[airing.tid], year * 12 + quarter * 3)) {
      shows.delete(airing.tid);
      continue;
    }
    const picked = current.get(airing.tid);
    const upcoming = airing.endsAt > now;
    if (picked?.endsAt > now || (!upcoming && picked?.startsAt > airing.startsAt)) continue;
    const { tid, id, title, episode, channel, startsAt: at, endsAt: end } = airing;
    current.set(tid, { tid, id, title, episode, channel, startsAt: at, endsAt: end });
  }
  for (const [tid, show] of current) shows.set(tid, show);
  return { key, shows: [...shows.values()].sort((a, b) => a.title.localeCompare(b.title, 'ja')) };
}

export async function refreshSchedule(db) {
  const refreshedAt = Date.now();
  const date = jstDate(refreshedAt);
  // スケジュール変更の反映中や同時起動でも、配信元への同期開始は日本時間で1日1回。
  const claim = await db.prepare(`INSERT INTO schedule VALUES(1, 0, json_object('airings', json_array(), 'attemptedOn', ?))
    ON CONFLICT(id) DO UPDATE SET airings = CASE
      WHEN json_type(schedule.airings) = 'array'
        THEN json_object('airings', json(schedule.airings), 'attemptedOn', ?)
      ELSE json_set(schedule.airings, '$.attemptedOn', ?)
    END
    WHERE COALESCE(json_extract(schedule.airings, '$.attemptedOn'), '') < ?
    RETURNING airings`).bind(date, date, date, date).first();
  if (!claim) return;

  const previous = readSnapshot(claim);
  const range = calendarRange(refreshedAt);
  const start = range.start;
  // 今期一覧で先の放送も拾えるよう、表示期間より広く同期する。
  const end = range.end + 6 * DAY;
  const data = await source({
    Req: 'ProgramByDate',
    // 配信元は午前5時区切りなので、前日の分から取得して日本時間の0時で絞る。
    start: jstDate(start - DAY), days: String((end - start) / DAY + 1), ChID: CHANNELS.join(',')
  });
  if (!data.Programs) throw new Error('番組表の形式が変わりました');
  const programs = Object.values(data.Programs);
  const ids = [...new Set(programs.map(program => String(program.TID)).filter(id => /^[1-9]\d{0,8}$/.test(id)))];
  const titles = {};
  const titleCache = {};
  const missing = [];
  for (const id of ids) {
    const entry = previous.titleCache?.[id];
    if (entry && refreshedAt - entry.updatedAt < 7 * DAY) {
      titles[id] = entry.title;
      titleCache[id] = entry;
    } else {
      missing.push(id);
    }
  }
  for (let offset = 0; offset < missing.length; offset += 100) {
    const group = missing.slice(offset, offset + 100);
    const data = await source({ Req: 'TitleShort', TID: group.join(',') });
    if (!data.Titles) throw new Error('作品情報の形式が変わりました');
    for (const id of group) {
      const value = data.Titles[id];
      if (!value?.Title) continue;
      const { Title, Cat, FirstYear, FirstMonth, FirstEndYear, FirstEndMonth } = value;
      const title = { Title, Cat, FirstYear, FirstMonth, FirstEndYear, FirstEndMonth };
      titles[id] = title;
      titleCache[id] = { title, updatedAt: refreshedAt };
    }
  }
  const airings = normalizeSchedule(programs, titles, start, end);
  if (!airings.length) throw new Error('取得対象の放送がありません');
  const season = buildSeason(airings, titles, previous.season, refreshedAt);
  const returnedPids = new Set(programs.map(program => Number(program.PID)));
  const pastAirings = previous.airings.filter(airing =>
    airing.startsAt >= start && airing.endsAt <= refreshedAt && !returnedPids.has(airing.pid));
  const calendar = [...pastAirings, ...airings].sort((a, b) => a.startsAt - b.startsAt || a.pid - b.pid);
  const threads = new Map();
  for (const airing of airings) {
    if (!threads.has(airing.id) || airing.subtitle) threads.set(airing.id, airing);
  }
  const rows = [...threads.values()];
  for (let offset = 0; offset < rows.length; offset += 18) {
    const chunk = rows.slice(offset, offset + 18);
    await db.prepare(`INSERT INTO threads (id, tid, episode, title, subtitle)
      VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,
      subtitle=COALESCE(NULLIF(excluded.subtitle,''), threads.subtitle)`)
      .bind(...chunk.flatMap(row => [row.id, row.tid, row.episode, row.title, row.subtitle])).run();
  }
  await db.prepare(`INSERT INTO schedule VALUES(1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET refreshed_at=excluded.refreshed_at, airings=excluded.airings
    WHERE excluded.refreshed_at >= schedule.refreshed_at`)
    .bind(refreshedAt, JSON.stringify({ airings: calendar, season, titleCache, attemptedOn: date })).run();
}

async function source(params) {
  const response = await fetch(`${SOURCE}/json.php?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': 'Anime-keijiban/1.0 (+https://github.com/matsu609/Anime-keijiban)' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`しょぼいカレンダー HTTP ${response.status}`);
  return response.json();
}
