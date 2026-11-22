import { XMLParser } from 'fast-xml-parser';

const SOURCE = 'https://cal.syoboi.jp';
const CHANNELS = [1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 19, 72, 100, 187];
const xml = new XMLParser({ parseTagValue: false, isArray: (_, path) => path.endsWith('.TitleItem') });
const ANIME_CATEGORIES = new Set([1, 7, 10]);
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' });

export function jstDate(time) {
  return dayFormat.format(time);
}

export function normalizeSchedule(programs, titles, start, end) {
  return programs.flatMap(program => {
    const title = titles.get(String(program.TID));
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

let refreshInFlight;

export function refreshSchedule(db) {
  refreshInFlight ??= syncSchedule(db).finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

async function syncSchedule(db) {
  const refreshedAt = Date.now();
  const today = Date.parse(jstDate(refreshedAt) + 'T00:00:00+09:00');
  const day = 86400000;
  const start = today - day;
  const end = today + 7 * day;
  const response = await source('/json.php', {
    Req: 'ProgramByDate', Start: jstDate(start), Days: '8', ChID: CHANNELS.join(',')
  });
  const data = await response.json();
  if (!data.Programs || typeof data.Programs !== 'object') throw new Error('番組表の形式が変わりました');
  const programs = Object.values(data.Programs);
  const ids = [...new Set(programs.map(program => String(program.TID)).filter(id => /^[1-9]\d{0,8}$/.test(id)))];
  const titles = new Map();
  for (let offset = 0; offset < ids.length; offset += 100) {
    const response = await source('/db.php', {
      Command: 'TitleLookup', TID: ids.slice(offset, offset + 100).join(','), Fields: 'TID,Title,Cat'
    });
    const result = xml.parse(await response.text()).TitleLookupResponse;
    if (result?.Result?.Code !== '200') throw new Error('作品情報を取得できませんでした');
    for (const title of result.TitleItems?.TitleItem ?? []) titles.set(title.TID, title);
  }
  const airings = normalizeSchedule(programs, titles, start, end);
  if (!airings.length) throw new Error('取得対象の放送がありません');

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
    .bind(refreshedAt, JSON.stringify(airings)).run();
}

async function source(path, params) {
  const response = await fetch(`${SOURCE}${path}?${new URLSearchParams(params)}`, {
    headers: { 'User-Agent': 'Anime-keijiban/1.0 (+https://github.com/matsu609/Anime-keijiban)' },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`しょぼいカレンダー HTTP ${response.status}`);
  return response;
}
