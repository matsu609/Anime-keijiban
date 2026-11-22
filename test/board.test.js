import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../src/worker.js';

test('番組表から同じ話数のスレッドに集まり、再同期後もコメントが残る', async t => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../migrations/0001_board.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      function wrap(args) {
        return {
          bind: (...values) => wrap(values),
          first: async () => statement.get(...args) ?? null,
          all: async () => ({ results: statement.all(...args) }),
          run: async () => statement.run(...args)
        };
      }
      return wrap([]);
    }
  };
  let now = Date.parse('2026-11-22T10:00:00+09:00');
  t.mock.method(Date, 'now', () => now);
  const makeProgram = (pid, tid, ch, episode = '8', day = 0) => {
    const start = now / 1000 + day * 86400;
    return {
      PID: String(pid), TID: String(tid), ChID: String(ch), ChName: 'テスト局',
      Count: episode, StTime: String(start), EdTime: String(start + 1200), SubTitle2: 'サブタイトル'
    };
  };
  const extraTitles = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [
    10000 + i, { Title: '対象外', Cat: '5' }
  ]));
  const titles = {
    ...extraTitles,
    8018: { Title: '作品 & テスト', Cat: '1' },
    8300: { Title: '情報番組', Cat: '5' },
    9000: { Title: '後日の今期作品', Cat: '1' },
    7000: { Title: '旧作の再放送', Cat: '10', FirstEndYear: '2025', FirstEndMonth: '12' }
  };
  const source = t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    assert.equal(url.pathname, '/json.php');
    const req = url.searchParams.get('Req');
    if (req === 'TitleShort') {
      const ids = url.searchParams.get('TID').split(',');
      assert.ok(ids.length <= 100);
      return Response.json({ Titles: Object.fromEntries(ids.map(id => [id, titles[id]])) });
    }
    assert.equal(req, 'ProgramByDate');
    assert.equal(url.searchParams.get('start'), new Date(now - 8 * 86400000).toISOString().slice(0, 10));
    assert.equal(url.searchParams.get('days'), '15');
    return Response.json({
      Programs: {
        41: makeProgram(41, 8018, 19),
        42: makeProgram(42, 8018, 5),
        43: makeProgram(43, 8300, 19),
        44: makeProgram(44, 8018, 20),
        45: makeProgram(45, 8018, 19, '', 1),
        46: makeProgram(46, 9000, 19, '2', 2),
        47: makeProgram(47, 7000, 19, '4', 1),
        48: makeProgram(48, 8018, 19, '7', -1),
        ...Object.fromEntries(Object.keys(extraTitles).map(id => [id, makeProgram(id, id, 19)]))
      }
    });
  });

  const origin = 'https://anime.example';
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const get = path => worker.fetch(new Request(origin + path), { DB }, context);
  const post = (body, source = origin) => worker.fetch(new Request(origin + '/api/threads/8018-e8', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify({ body })
  }), { DB }, context);

  const empty = await (await get('/api/schedule')).json();
  assert.deepEqual(empty, { updatedAt: null, airings: [], season: null });
  sqlite.prepare('INSERT INTO schedule VALUES (1, ?, ?)').run(now - 86400000, JSON.stringify([]));
  assert.equal((await (await get('/api/schedule')).json()).season, null);
  assert.equal(source.mock.callCount(), 0);

  await worker.scheduled({}, { DB }, context);
  await Promise.all(pending);
  const schedule = await get('/api/schedule');
  assert.equal(schedule.status, 200);
  const data = await schedule.json();
  assert.deepEqual(data.airings.map(row => row.id), ['8018-e8', '8018-e8', '8018-p45', '7000-e4']);
  assert.equal(data.season.key, '2026-3');
  assert.deepEqual(data.season.shows.map(show => show.tid).sort(), [8018, 9000]);
  assert.equal(data.season.shows.find(show => show.tid === 8018).id, '8018-e8');
  assert.equal(source.mock.callCount(), 3);
  await worker.scheduled({}, { DB }, context);
  await Promise.all(pending);
  assert.equal(source.mock.callCount(), 3);
  assert.equal((await post('実況テスト', 'https://another.example')).status, 403);
  assert.equal((await post('　')).status, 400);
  const comment = await post('実況テスト');
  assert.equal(comment.status, 201);
  const { comment: saved } = await comment.json();
  for (let i = 0; i < 3; i++) assert.equal((await post('感想テスト')).status, 201);
  assert.equal((await post('連続投稿')).status, 429);

  now += 86400000;
  await worker.scheduled({}, { DB }, context);
  await Promise.all(pending);
  assert.equal(source.mock.callCount(), 4);
  const thread = await (await get('/api/threads/8018-e8')).json();
  assert.equal(thread.thread.title, '作品 & テスト');
  assert.equal(thread.comments[0].body, '実況テスト');
  assert.equal(thread.comments.length, 4);
  const updates = await (await get('/api/threads/8018-e8?after=' + saved.id)).json();
  assert.equal(updates.comments.length, 3);
  const popular = await (await get('/api/popular')).json();
  assert.equal(popular.threads[0].count, 4);
});
