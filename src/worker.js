import { refreshSchedule } from './schedule.js';

const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const error = (message, status) => json({ error: message }, status);
const threadPattern = /^[1-9]\d{0,8}-[ep][1-9]\d{0,8}$/;

async function schedule(env, context) {
  const read = () => env.DB.prepare('SELECT refreshed_at, airings FROM schedule WHERE id = 1').first();
  let snapshot = await read();
  if (!snapshot) {
    await refreshSchedule(env.DB);
    snapshot = await read();
  } else if (Date.now() - snapshot.refreshed_at > 2 * 3600000) {
    context.waitUntil(refreshSchedule(env.DB).catch(console.error));
  }
  return json({ updatedAt: snapshot.refreshed_at, airings: JSON.parse(snapshot.airings) });
}

async function thread(env, id, url) {
  const item = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first();
  if (!item) return error('スレッドが見つかりません。', 404);
  const after = Number(url.searchParams.get('after'));
  if (!Number.isSafeInteger(after) || after < 0) return error('取得位置が不正です。', 400);
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam === null ? Number.MAX_SAFE_INTEGER : Number(beforeParam);
  if (!Number.isSafeInteger(before) || before < 1 || (after && beforeParam !== null)) {
    return error('取得位置が不正です。', 400);
  }
  const order = after ? 'ASC' : 'DESC';
  const { results } = await env.DB.prepare(`SELECT id, body, posted_at FROM comments
    WHERE thread_id = ? AND id > ? AND id < ? ORDER BY id ${order} LIMIT 51`)
    .bind(id, after, before).all();
  const page = results.slice(0, 50);
  return json({ thread: item, comments: after ? page : page.reverse(), more: results.length > 50 });
}

async function post(env, id, request, url) {
  if (request.headers.get('Origin') !== url.origin) return error('このページから投稿してください。', 403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return error('無効な投稿形式です。', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) return error('コメントを入力してください。', 400);
  let size = 0;
  let raw = '';
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      return error('投稿データが大きすぎます。', 413);
    }
    raw += decoder.decode(value, { stream: true });
  }
  let data;
  try {
    data = JSON.parse(raw + decoder.decode());
  } catch {
    return error('無効な投稿形式です。', 400);
  }
  const body = typeof data?.body === 'string' ? data.body.trim() : '';
  if (!body || [...body].length > 500) return error('コメントは1〜500文字で入力してください。', 400);
  const exists = await env.DB.prepare('SELECT 1 FROM threads WHERE id = ?').bind(id).first();
  if (!exists) return error('スレッドが見つかりません。', 404);

  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bucket = new Date(now).toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${bucket}:${ip}`));
  const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const result = await env.DB.prepare(`INSERT INTO comments(thread_id, body, posted_at, author_key)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM comments WHERE author_key = ? AND posted_at >= ?) < 4
    RETURNING id, body, posted_at`).bind(id, body, now, key, key, now - 60000).first();
  return result ? json({ comment: result }, 201) : error('投稿間隔を空けてもう一度お試しください。', 429);
}

export default {
  async scheduled(_event, env, context) {
    context.waitUntil(refreshSchedule(env.DB));
  },

  async fetch(request, env, context) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith('/thread/') && threadPattern.test(pathname.slice(8))) {
      return env.ASSETS.fetch(new Request(new URL('/', url), request));
    }
    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (request.method === 'GET' && pathname === '/api/schedule') return await schedule(env, context);
      if (request.method === 'GET' && pathname === '/api/popular') {
        const { results } = await env.DB.prepare(`SELECT t.id, t.title, t.episode, COUNT(*) AS count
          FROM comments AS c JOIN threads AS t ON c.thread_id = t.id WHERE c.posted_at >= ?
          GROUP BY t.id ORDER BY count DESC, MAX(c.id) DESC LIMIT 8`)
          .bind(Date.now() - 7 * 86400000).all();
        return json({ threads: results });
      }
      const [, id] = /^\/api\/threads\/([^/]+)$/.exec(pathname) ?? [];
      if (id && threadPattern.test(id)) {
        if (request.method === 'GET') return await thread(env, id, url);
        if (request.method === 'POST') return await post(env, id, request, url);
        return error('この操作は利用できません。', 405);
      }
      return error('ページが見つかりません。', 404);
    } catch (cause) {
      console.error(cause);
      return error('データを読み込めませんでした。時間をおいてお試しください。', 503);
    }
  }
};
