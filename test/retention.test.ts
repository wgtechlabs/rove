import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { createChat } from '../src/chat.js';
import { testRuntime } from './storage.js';

const DAY = 86_400_000;

async function fixture(t: TestContext) {
  const config = await testRuntime(t);
  const chat = await createChat(config);
  t.after(() => chat.close());
  const now = Date.now();
  async function seed(scope = 'web', age = 15) {
    const conversation = await chat.create(scope);
    const requestId = randomUUID();
    const run = {
      id: requestId,
      conversation: conversation.id,
      scope: `${scope}:${conversation.id}`,
      status: 'done',
      prompt: 'private prompt',
      answer: 'private reply',
      history: [{ role: 'tool', content: 'private tool result' }],
      steps: 1,
      pending: {
        id: randomUUID(),
        arguments: { secret: 'private argument' },
        detail: 'private preview',
      },
    };
    await config.db.run(
      'UPDATE rove_conversation SET title=$1,last_activity_at=$2,updated_at=$2 WHERE id=$3',
      ['private title', now - age * DAY, conversation.id],
    );
    await config.db.run(
      'INSERT INTO rove_exchange(request_id,conversation_id,prompt,reply) VALUES($1,$2,$3,$4)',
      [requestId, conversation.id, run.prompt, run.answer],
    );
    await config.db.run(
      'INSERT INTO rove_run(id,conversation,scope,data) VALUES($1,$2,$3,$4)',
      [requestId, conversation.id, run.scope, JSON.stringify(run)],
    );
    return { id: conversation.id, requestId, run, scope };
  }
  return { config, chat, now, seed };
}

test('additive lifecycle migration preserves history and derives old activity without resetting age', async (t) => {
  const config = await testRuntime(t);
  const id = randomUUID();
  const pendingId = randomUUID();
  const old = Date.now() - 30 * DAY;
  await config.db.exec(`
    CREATE TABLE rove_conversation(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated_at BIGINT NOT NULL,scope TEXT NOT NULL DEFAULT 'web');
    CREATE TABLE rove_run(sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,id TEXT PRIMARY KEY,conversation TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL);
  `);
  await config.db.run(
    'INSERT INTO rove_conversation VALUES($1,$2,$3,$4),($5,$6,$3,$4)',
    [id, 'Old title', old, 'web', pendingId, 'Pending title'],
  );
  await config.db.run(
    'INSERT INTO rove_run(id,conversation,scope,data) VALUES($1,$2,$3,$4)',
    [
      randomUUID(),
      pendingId,
      `web:${pendingId}`,
      JSON.stringify({ status: 'waiting', pending: { created: old + DAY } }),
    ],
  );
  const chat = await createChat(config);
  t.after(() => chat.close());
  assert.equal((await chat.get(id)).lastActivityAt, old);
  assert.equal(
    (
      await config.db.get(
        'SELECT last_activity_at FROM rove_conversation WHERE id=$1',
        [pendingId],
      )
    )?.last_activity_at,
    old + DAY,
  );
  assert.equal((await chat.get(id)).title, 'Old title');
  assert.equal((await chat.get(id)).archivedAt, null);
  const activity = old + 2 * DAY;
  await config.db.run(
    'UPDATE rove_conversation SET last_activity_at=$1 WHERE id=$2',
    [activity, id],
  );
  await chat.close();
  const restarted = await createChat(config);
  t.after(() => restarted.close());
  assert.equal((await restarted.get(id)).lastActivityAt, activity);
});

test('conversation pages reach beyond 200, preserve scope, and archive with stale-write protection', async (t) => {
  const f = await fixture(t);
  await f.config.db.run(
    `INSERT INTO rove_conversation(id,title,updated_at,scope,last_activity_at)
    SELECT 'seed-' || n,'Existing conversation',$1,'web',$1 FROM generate_series(1,240) AS n`,
    [f.now],
  );
  const newest = await f.chat.create();
  await f.chat.create('slack:team:channel:thread');
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await f.chat.listPage('web', { limit: 37, cursor });
    assert.ok(page.items.length <= 37);
    for (const item of page.items) {
      assert.equal(ids.has(item.id), false);
      ids.add(item.id);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(ids.size, 241);
  const archived = await f.chat.archive(newest.id, {
    archived: true,
    expectedUpdatedAt: newest.updatedAt,
  });
  assert.ok(archived.archivedAt);
  assert.equal(archived.lastActivityAt, newest.lastActivityAt);
  assert.equal(
    (await f.chat.listPage('web', { state: 'archived' })).items[0]?.id,
    newest.id,
  );
  await assert.rejects(
    f.chat.archive(newest.id, {
      archived: false,
      expectedUpdatedAt: newest.updatedAt,
    }),
    /changed/,
  );
  await assert.rejects(
    f.chat.archive(
      newest.id,
      { archived: false, expectedUpdatedAt: archived.updatedAt },
      'another-scope',
    ),
    /not found/,
  );
  const restored = await f.chat.archive(newest.id, {
    archived: false,
    expectedUpdatedAt: archived.updatedAt,
  });
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.lastActivityAt, newest.lastActivityAt);
  await assert.rejects(f.chat.listPage('web', { limit: 101 }), /page size/);
  const page = await f.chat.listPage('web', { limit: 1 });
  await assert.rejects(
    f.chat.listPage('web', {
      state: 'archived',
      cursor: page.nextCursor ?? '',
    }),
    /cursor/,
  );
});

test('private 14-day and authoritative public 90-day expiry scrub duplicates while retaining AIPs and request receipts', async (t) => {
  const f = await fixture(t);
  const privateOld = await f.seed('web', 14);
  const privateYoung = await f.seed(
    'plugin-channel:installed:thread',
    14 - 1 / DAY,
  );
  const publicOld = await f.seed('slack:team:public:old', 90);
  const publicYoung = await f.seed('slack:team:public:young', 90 - 1 / DAY);
  const unknown = await f.seed('slack:team:unknown:thread', 14);
  await f.config.db.exec(
    'CREATE TABLE rove_aip(id TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL)',
  );
  await f.config.db.run('INSERT INTO rove_aip VALUES($1,$2,$3)', [
    'proposal',
    `web:${privateOld.id}`,
    'Independent reviewed proposal',
  ]);
  const resolve = async ({ scope }: { scope: string }) => {
    if (scope.includes(':unknown:')) throw new Error('Visibility unavailable');
    return 'public' as const;
  };
  assert.deepEqual(await f.chat.purgeExpired(f.now, resolve), {
    checked: 4,
    expired: 3,
  });
  for (const item of [privateOld, publicOld, unknown]) {
    const expired = await f.chat.get(item.id, item.scope);
    assert.equal(expired.expiredAt, f.now);
    assert.deepEqual(expired.messages, []);
    assert.equal(
      expired.title,
      item === publicOld ? 'private title' : 'Expired conversation',
    );
    const exchange = await f.config.db.get(
      'SELECT * FROM rove_exchange WHERE request_id=$1',
      [item.requestId],
    );
    assert.equal(exchange?.prompt, '');
    assert.equal(exchange?.reply, '');
    assert.equal(exchange?.expired, true);
    const run = await f.config.db.get('SELECT * FROM rove_run WHERE id=$1', [
      item.requestId,
    ]);
    assert.equal(run?.expired, true);
    assert.equal(String(run?.data).includes('private'), false);
    assert.equal(JSON.parse(String(run?.data)).pending, undefined);
    await assert.rejects(
      f.chat.send(
        item.id,
        { content: item.run.prompt, requestId: item.requestId },
        item.scope,
      ),
      /expired/,
    );
    await assert.rejects(
      f.chat.decide(
        item.id,
        { approvalId: item.run.pending.id, decision: 'approve' },
        item.scope,
      ),
      /no longer pending/,
    );
  }
  assert.equal(
    (await f.chat.get(privateYoung.id, privateYoung.scope)).messages.length,
    2,
  );
  assert.equal(
    (await f.chat.get(publicYoung.id, publicYoung.scope)).messages.length,
    2,
  );
  assert.equal(
    (
      await f.config.db.get('SELECT data FROM rove_aip WHERE id=$1', [
        'proposal',
      ])
    )?.data,
    'Independent reviewed proposal',
  );
  assert.deepEqual(await f.chat.purgeExpired(f.now, resolve), {
    checked: 2,
    expired: 0,
  });
  await f.chat.purgeExpired(f.now, async () => 'private');
  assert.equal(
    (await f.chat.get(publicOld.id, publicOld.scope)).title,
    'Expired conversation',
  );
});

test('expiry skips unfinished approvals, protects active turns, and rechecks activity after visibility lookup', async (t) => {
  const f = await fixture(t);
  for (const status of ['waiting', 'ready', 'executing']) {
    const item = await f.seed(`slack:team:${status}:thread`, 30);
    await f.config.db.run('UPDATE rove_run SET data=$1 WHERE id=$2', [
      JSON.stringify({ ...item.run, status }),
      item.requestId,
    ]);
  }
  const changed = await f.seed('slack:team:changed:thread', 30);
  const result = await f.chat.purgeExpired(f.now, async ({ id }) => {
    if (id === changed.id)
      await f.config.db.run(
        'UPDATE rove_conversation SET last_activity_at=$1 WHERE id=$2',
        [f.now, id],
      );
    return 'private';
  });
  assert.deepEqual(result, { checked: 4, expired: 0 });
  await f.config.state.withTurn({ kind: 'message' }, async () => {
    await assert.rejects(f.chat.purgeExpired(f.now), /busy/);
  });
  assert.equal((await f.chat.get(changed.id, changed.scope)).expiredAt, null);
});

test('queued channel work blocks expiry by scope or conversation and terminal duplicates are scrubbed', async (t) => {
  const f = await fixture(t);
  for (const table of ['rove_slack_job', 'rove_plugin_channel_job'])
    await f.config.db.exec(
      `CREATE TABLE ${table}(id TEXT PRIMARY KEY,scope TEXT NOT NULL,conversation TEXT NOT NULL,status TEXT NOT NULL,content TEXT NOT NULL,reply TEXT NOT NULL,snapshot TEXT NOT NULL DEFAULT '')`,
    );
  const queued = await f.seed('slack:team:queued:thread', 30);
  const delivering = await f.seed('plugin-channel:installed:delivering', 30);
  const terminal = await f.seed('plugin-channel:installed:terminal', 30);
  await f.config.db.run(
    "INSERT INTO rove_slack_job(id,scope,conversation,status,content,reply) VALUES('queued',$1,'','pending','queued prompt','')",
    [queued.scope],
  );
  await f.config.db.run(
    "INSERT INTO rove_plugin_channel_job VALUES('delivering','other-scope',$1,'delivering','queued prompt','reply','snapshot')",
    [delivering.id],
  );
  await f.config.db.run(
    "INSERT INTO rove_slack_job(id,scope,conversation,status,content,reply) VALUES('terminal',$1,$2,'failed','copied prompt','copied reply')",
    [terminal.scope, terminal.id],
  );
  assert.deepEqual(await f.chat.purgeExpired(f.now), {
    checked: 3,
    expired: 1,
  });
  assert.equal((await f.chat.get(queued.id, queued.scope)).messages.length, 2);
  assert.equal(
    (await f.chat.get(delivering.id, delivering.scope)).messages.length,
    2,
  );
  assert.deepEqual(
    await f.config.db.get(
      'SELECT content,reply FROM rove_slack_job WHERE id=$1',
      ['terminal'],
    ),
    { content: '', reply: '' },
  );
  assert.equal(
    (
      await f.config.db.get('SELECT content FROM rove_slack_job WHERE id=$1', [
        'queued',
      ])
    )?.content,
    'queued prompt',
  );
});

test('retention batches never exceed 200 and young public rows cannot starve older private candidates', async (t) => {
  const f = await fixture(t);
  await f.config.db.run(
    `INSERT INTO rove_conversation(id,title,updated_at,scope,last_activity_at)
    SELECT 'public-' || n,'Public conversation',$1,'slack:team:public:' || n,$1 FROM generate_series(1,200) AS n`,
    [f.now - 50 * DAY],
  );
  const privateOld = await f.seed('web', 30);
  let lookups = 0;
  const resolve = async () => {
    lookups++;
    return 'public' as const;
  };
  assert.deepEqual(await f.chat.purgeExpired(f.now, resolve), {
    checked: 200,
    expired: 0,
  });
  assert.equal(lookups, 200);
  assert.deepEqual(await f.chat.purgeExpired(f.now, resolve), {
    checked: 200,
    expired: 1,
  });
  assert.equal((await f.chat.get(privateOld.id)).expiredAt, f.now);
});

test('visibility lookup does not hold the core turn and shutdown cancels an unresponsive lookup', async (t) => {
  const f = await fixture(t);
  await f.seed('slack:team:slow:thread', 30);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = f.chat.purgeExpired(f.now, async () => {
    entered();
    return new Promise<never>(() => {});
  });
  const rejected = assert.rejects(running);
  await started;
  await f.config.state.withTurn({ kind: 'message' }, async () => {});
  await f.chat.close();
  await rejected;
});
