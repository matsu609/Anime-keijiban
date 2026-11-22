const el = id => document.getElementById(id);
const timezone = 'Asia/Tokyo';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fullDate = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, month: 'long', day: 'numeric', weekday: 'short' });
const shortDate = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, month: 'numeric', day: 'numeric' });
const dayMilliseconds = 86400000;
const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value) element.textContent = value;
  if (className) element.className = className;
  return element;
}

async function api(path, options) {
  const result = await fetch(path, options);
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || '読み込めませんでした。');
  return data;
}

function threadLink(airing) {
  const a = node('a');
  a.href = '/thread/' + airing.id;
  return a;
}

const episodeLabel = episode => episode ? '第' + episode + '話' : '話数未定';

async function showSchedule() {
  const today = dateFormat.format(new Date());
  const midnight = Date.parse(today + 'T00:00:00+09:00');
  const tomorrow = midnight + dayMilliseconds;
  const otherDay = el('other-day');
  let selected = today;
  let airings = [];
  let loaded = false;
  const dayButtons = [[midnight, '今日'], [tomorrow, '明日']].map(([day, label]) => {
    const button = node('button');
    button.type = 'button';
    button.dataset.date = dateFormat.format(day);
    button.setAttribute('aria-label', label + ' ' + fullDate.format(day));
    button.append(node('span', label), node('strong', shortDate.format(day)));
    button.addEventListener('click', () => {
      selected = button.dataset.date;
      otherDay.value = '';
      render();
    });
    return button;
  });
  el('days').replaceChildren(...dayButtons);
  for (let offset = 1; offset <= 7; offset++) {
    const day = midnight - offset * dayMilliseconds;
    otherDay.add(new Option(fullDate.format(day), dateFormat.format(day)));
  }
  otherDay.addEventListener('change', () => {
    selected = otherDay.value || today;
    render();
  });

  function render() {
    dayButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.date === selected)));
    el('selected-day').textContent = fullDate.format(Date.parse(selected + 'T00:00:00+09:00'));
    if (!loaded) return;
    const filtered = airings.filter(airing => dateFormat.format(airing.startsAt) === selected &&
      (!el('channel').value || el('channel').value === airing.channel));
    el('schedule').replaceChildren(...filtered.map(airing => {
      const row = threadLink(airing);
      row.className = 'airing';
      const live = airing.startsAt <= Date.now() && airing.endsAt > Date.now();
      const time = node('div', null, 'air-time');
      time.append(node('strong', timeFormat.format(airing.startsAt)), node('small', live ? '放送中' : timeFormat.format(airing.endsAt), live ? 'live' : ''));
      const details = node('div', null, 'air-details');
      details.append(node('small', airing.channel + (airing.episode ? ' ／ ' + episodeLabel(airing.episode) : '')),
        node('strong', airing.title));
      if (airing.subtitle) details.append(node('small', airing.subtitle));
      row.append(time, details, node('span', '↗', 'arrow'));
      return row;
    }));
    if (!filtered.length) {
      const message = el('channel').value && airings.some(airing => dateFormat.format(airing.startsAt) === selected)
        ? 'この放送局の番組データはありません。'
        : 'この日の番組データはありません。';
      el('schedule').append(node('p', message, 'empty'));
    }
  }

  el('channel').addEventListener('change', render);
  render();
  try {
    const data = await api('/api/schedule');
    airings = data.airings;
    if (data.updatedAt) el('schedule-updated').textContent = '更新 ' + dateTime.format(data.updatedAt);
    renderSeason(data.season);
    const channels = [...new Set(airings.map(airing => airing.channel))].sort((a, b) => a.localeCompare(b, 'ja'));
    el('channel').append(...channels.map(channel => new Option(channel, channel)));
    loaded = true;
    render();
    setInterval(() => {
      if (dateFormat.format(new Date()) === today) render();
      else location.reload();
    }, 60000);
  } catch (cause) {
    el('season-list').replaceChildren(node('p', cause.message, 'empty'));
    const retry = node('button', '再読み込み', 'plain');
    retry.addEventListener('click', () => location.reload());
    el('schedule').replaceChildren(node('p', cause.message, 'empty'), retry);
  }
}

function renderSeason(season) {
  if (!season) {
    el('season-list').replaceChildren(node('p', '次回の番組表更新で今期の作品を読み込みます。', 'empty'));
    return;
  }
  const [year, quarter] = season.key.split('-').map(Number);
  el('season-period').textContent = year + '年' + ['冬', '春', '夏', '秋'][quarter] + ' ／ 関東';
  if (!season.shows.length) {
    el('season-list').replaceChildren(node('p', '今期の放送作品はまだ登録されていません。', 'empty'));
    return;
  }
  const list = node('ul', null, 'season-list');
  const now = Date.now();
  for (const show of season.shows) {
    const item = node('li');
    const link = threadLink(show);
    const info = node('div', null, 'air-details');
    const episode = (show.episode ? episodeLabel(show.episode) + ' ／ ' : '') + show.channel;
    const date = (show.endsAt > now ? '次回 ' : '前回 ') + dateTime.format(show.startsAt);
    info.append(node('strong', show.title), node('small', episode + ' ／ ' + date));
    link.append(info, node('span', '↗', 'arrow'));
    item.append(link);
    list.append(item);
  }
  el('season-list').replaceChildren(list);
}

async function showRanking() {
  try {
    const { threads } = await api('/api/popular');
    if (!threads.length) {
      el('ranking').replaceChildren(node('p', 'まだ投稿されたスレッドはありません。', 'empty'));
      return;
    }
    const list = node('ol', null, 'ranking');
    threads.forEach((thread, i) => {
      const item = node('li');
      const link = threadLink(thread);
      const detail = node('div');
      detail.append(node('strong', thread.title), node('small', episodeLabel(thread.episode) + ' ／ ' + thread.count + '件'));
      link.append(node('span', String(i + 1), 'rank'), detail, node('span', '↗', 'arrow'));
      item.append(link);
      list.append(item);
    });
    el('ranking').replaceChildren(list);
  } catch (cause) {
    el('ranking').replaceChildren(node('p', cause.message, 'empty'));
  }
}

async function showVotes(path) {
  const good = el('vote-good');
  const bad = el('vote-bad');
  const status = el('vote-status');
  el('thread-votes').hidden = false;
  let headers;
  let selected = 0;

  function render(result) {
    selected = result.vote;
    good.textContent = '＋ グッド ' + result.good;
    bad.textContent = '− バッド ' + result.bad;
    good.setAttribute('aria-pressed', String(selected === 1));
    bad.setAttribute('aria-pressed', String(selected === -1));
  }

  try {
    let voter = localStorage.getItem('thread-voter-id');
    if (!voter) {
      voter = crypto.randomUUID();
      localStorage.setItem('thread-voter-id', voter);
    }
    headers = { 'X-Voter-ID': voter };
    render(await api(path, { headers }));
  } catch {
    status.textContent = '投票を読み込めませんでした。';
    return;
  }
  good.disabled = bad.disabled = false;

  async function vote(value) {
    good.disabled = bad.disabled = true;
    status.textContent = '';
    try {
      render(await api(path + '?vote=' + (selected === value ? 0 : value), { method: 'PUT', headers }));
    } catch (cause) {
      status.textContent = cause.message;
    } finally {
      good.disabled = bad.disabled = false;
    }
  }
  good.addEventListener('click', () => vote(1));
  bad.addEventListener('click', () => vote(-1));
}

async function showThread() {
  el('home').hidden = true;
  el('thread').hidden = false;
  const path = '/api/threads/' + location.pathname.split('/').at(-1);
  let latest = 0;
  let earliest = 0;
  const known = new Set();

  function addComments(comments, prepend = false) {
    const items = [];
    for (const comment of comments) {
      if (known.has(comment.id)) continue;
      known.add(comment.id);
      earliest = earliest ? Math.min(earliest, comment.id) : comment.id;
      latest = Math.max(latest, comment.id);
      const item = node('li', null, 'comment');
      const header = node('div', '名無し · ' + dateTime.format(comment.posted_at), 'comment-meta');
      item.append(header, node('p', comment.body));
      items.push(item);
    }
    if (prepend) el('comments').prepend(...items);
    else el('comments').append(...items);
    el('no-comments').hidden = known.size > 0;
  }

  let refreshing = false;
  const update = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      let more;
      do {
        const result = await api(path + '?after=' + latest);
        addComments(result.comments);
        more = result.more;
        if (!result.comments.length) break;
      } while (more);
    } finally {
      refreshing = false;
    }
  };

  try {
    const result = await api(path);
    const info = result.thread;
    el('thread-title').textContent = info.title;
    document.title = info.title + ' | アニメ掲示板';
    el('episode').textContent = episodeLabel(info.episode);
    el('subtitle').textContent = info.subtitle;
    addComments(result.comments);
    el('older').hidden = !result.more;
    el('discussion').hidden = false;
    showVotes(path + '/votes');
  } catch (cause) {
    el('thread-title').textContent = cause.message;
    return;
  }

  el('older').addEventListener('click', async () => {
    const button = el('older');
    button.disabled = true;
    try {
      const result = await api(path + '?before=' + earliest);
      addComments(result.comments, true);
      button.hidden = !result.more;
    } catch (cause) {
      el('post-status').textContent = cause.message;
    } finally {
      button.disabled = false;
    }
  });
  setInterval(() => {
    if (!document.hidden) update().catch(() => {});
  }, 15000);

  el('comment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    const body = el('body').value.trim();
    if (!body || [...body].length > 500) {
      el('post-status').textContent = 'コメントは1〜500文字で入力してください。';
      return;
    }
    button.disabled = true;
    el('post-status').textContent = '投稿中…';
    try {
      await api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      el('body').value = '';
      el('post-status').textContent = '投稿しました。';
      await update().catch(() => {});
    } catch (cause) {
      el('post-status').textContent = cause.message;
    } finally {
      button.disabled = false;
    }
  });
}

if (location.pathname.startsWith('/thread/')) showThread();
else {
  showSchedule();
  showRanking();
}
