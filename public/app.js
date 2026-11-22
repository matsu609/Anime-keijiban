const el = id => document.getElementById(id);
const timezone = 'Asia/Tokyo';
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone });
const timeFormat = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const weekday = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, weekday: 'short' });
const fullDate = new Intl.DateTimeFormat('ja-JP', { timeZone: timezone, month: 'long', day: 'numeric', weekday: 'short' });
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
  const range = Array.from({ length: 8 }, (_, i) => midnight + (i - 1) * 86400000);
  let selected = today;
  let airings = [];
  let loaded = false;
  const dayButtons = range.map(day => {
    const button = node('button');
    button.type = 'button';
    button.dataset.date = dateFormat.format(day);
    button.append(node('span', day === midnight ? '今日' : weekday.format(day)), node('strong', button.dataset.date.slice(8)));
    button.addEventListener('click', () => {
      selected = button.dataset.date;
      render();
    });
    return button;
  });
  el('days').replaceChildren(...dayButtons);

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
    if (!filtered.length) el('schedule').append(node('p', 'この条件の放送予定はありません。', 'empty'));
  }

  el('channel').addEventListener('change', render);
  render();
  try {
    ({ airings } = await api('/api/schedule'));
    const channels = [...new Set(airings.map(airing => airing.channel))].sort((a, b) => a.localeCompare(b, 'ja'));
    el('channel').append(...channels.map(channel => new Option(channel, channel)));
    loaded = true;
    render();
    setInterval(render, 60000);
  } catch (cause) {
    const retry = node('button', '再読み込み', 'plain');
    retry.addEventListener('click', () => location.reload());
    el('schedule').replaceChildren(node('p', cause.message, 'empty'), retry);
  }
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
