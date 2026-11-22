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
  const now = Math.floor(Date.now() / 1000);
  const makeProgram = (pid, tid, ch, episode = '8') => ({
    PID: String(pid), TID: String(tid), ChID: String(ch), ChName: 'テスト局',
    Count: episode, StTime: String(now), EdTime: String(now + 1200), SubTitle2: 'サブタイトル'
  });
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    if (url.pathname === '/json.php') {
      assert.equal(url.searchParams.get('Req'), 'ProgramByDate');
      return Response.json({ Programs: {
        41: makeProgram(41, 8018, 19),
        42: makeProgram(42, 8018, 5),
        43: makeProgram(43, 8300, 19),
        44: makeProgram(44, 8018, 20),
        45: makeProgram(45, 8018, 19, '')
      } });
    }
    assert.equal(url.searchParams.get('Command'), 'TitleLookup');
    return new Response(`<TitleLookupResponse><Result><Code>200</Code></Result><TitleItems>
      <TitleItem id="8018"><TID>8018</TID><Title>作品 &amp; テスト</Title><Cat>1</Cat></TitleItem>
      <TitleItem id="8300"><TID>8300</TID><Title>情報番組</Title><Cat>5</Cat></TitleItem>
      </TitleItems></TitleLookupResponse>`);
  });

  const origin = 'https://anime.example';
  const pending = [];
  const context = { waitUntil(promise) { pending.push(promise); } };
  const get = path => worker.fetch(new Request(origin + path), { DB }, context);
  const post = (body, source = origin) => worker.fetch(new Request(origin + '/api/threads/8018-e8', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify({ body })
  }), { DB }, context);

  const schedule = await get('/api/schedule');
  assert.equal(schedule.status, 200);
  assert.deepEqual((await schedule.json()).airings.map(row => row.id), ['8018-e8', '8018-e8', '8018-p45']);
  assert.equal((await post('実況テスト', 'https://another.example')).status, 403);
  assert.equal((await post('　')).status, 400);
  const comment = await post('実況テスト');
  assert.equal(comment.status, 201);
  const { comment: saved } = await comment.json();
  for (let i = 0; i < 3; i++) assert.equal((await post('感想テスト')).status, 201);
  assert.equal((await post('連続投稿')).status, 429);

  await worker.scheduled({}, { DB }, context);
  await Promise.all(pending);
  const thread = await (await get('/api/threads/8018-e8')).json();
  assert.equal(thread.thread.title, '作品 & テスト');
  assert.equal(thread.comments[0].body, '実況テスト');
  assert.equal(thread.comments.length, 4);
  const updates = await (await get('/api/threads/8018-e8?after=' + saved.id)).json();
  assert.equal(updates.comments.length, 3);
  const popular = await (await get('/api/popular')).json();
  assert.equal(popular.threads[0].count, 4);
});
