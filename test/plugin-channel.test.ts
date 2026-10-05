import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from '../src/auth.js';
import { createChat } from '../src/chat.js';
import type { Database } from '../src/database.js';
import {
  type ActiveChannel,
  channelAccess,
  channelSpec,
  createPluginChannels,
} from '../src/plugin-channel.js';
import { testRuntime } from './storage.js';

const origin = 'https://rove.example';
const spec = channelSpec.parse({
  type: 'hmac-json',
  signing: {
    secret: 'signing-key',
    timestampHeader: 'x-test-time',
    signatureHeader: 'x-test-signature',
  },
  incoming: {
    eventId: '/event',
    tenant: '/tenant',
    actor: '/actor',
    destination: '/room',
    thread: '/thread',
    text: '/text',
    approvalId: '/approval',
    decision: '/decision',
  },
  outgoing: {
    url: 'https://93.184.216.34/send',
    secret: 'delivery-key',
    fields: { destination: 'room', thread: 'thread', text: 'text' },
  },
});
const initial: ActiveChannel = {
  revision: randomUUID(),
  digest: 'a'.repeat(64),
  spec,
  tenant: 'company',
  users: ['alice', 'admin'],
  admins: ['admin'],
  destinations: ['room'],
  secrets: {
    'signing-key': 'local-test-signing-key',
    'delivery-key': 'local-test-delivery-key',
  },
};
function event(overrides: Record<string, unknown> = {}) {
  return {
    event: randomUUID(),
    tenant: 'company',
    actor: 'alice',
    room: 'room',
    thread: 'thread',
    text: 'Hello',
    ...overrides,
  };
}
function signed(
  body: unknown,
  state = initial,
  stamp = Math.floor(Date.now() / 1000),
) {
  const raw = JSON.stringify(body);
  return new Request(`${origin}/api/channels/test/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [state.spec.signing.timestampHeader]: String(stamp),
      [state.spec.signing.signatureHeader]: `v1=${createHmac(
        'sha256',
        state.secrets[state.spec.signing.secret] || '',
      )
        .update(`v1:${stamp}:${raw}`)
        .digest('hex')}`,
    },
    body: raw,
  });
}
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 120; n++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for installed channel processing.');
}
async function fixture(
  t: TestContext,
  realChat = false,
  beforeGateway?: (database: Database) => Promise<void>,
) {
  let cleanup: (() => Promise<void>) | undefined;
  t.after(() => cleanup?.());
  const config = await testRuntime(t);
  await beforeGateway?.(config.db);
  const posts: Record<string, unknown>[] = [];
  let deliveryStatus = 200;
  let dropDelivery = false;
  let releaseDelivery: (() => void) | undefined;
  let blockedDelivery: Promise<void> | undefined;
  let releaseModel: (() => void) | undefined;
  let blockedModel: Promise<void> | undefined;
  let modelCalls = 0;
  let modelTools = false;
  let failContinuation = false;
  let toolExecutions = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/chat/completions') {
      modelCalls++;
      await blockedModel;
      assert.equal(request.headers.authorization, 'Bearer fake-model-key');
      if (modelTools && body.messages.at(-1)?.role !== 'tool') {
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call-local',
                      type: 'function',
                      function: {
                        name: 'write',
                        arguments: JSON.stringify({ text: 'approved write' }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      } else if (failContinuation) {
        failContinuation = false;
        response.statusCode = 500;
        response.end('{}');
      } else {
        response.end(
          JSON.stringify({
            choices: [
              { message: { content: `Local model answer ${modelCalls}.` } },
            ],
          }),
        );
      }
    } else {
      assert.equal(
        request.headers.authorization,
        'Bearer local-test-delivery-key',
      );
      posts.push(body);
      await blockedDelivery;
      if (dropDelivery) {
        request.socket.destroy();
        return;
      }
      response.statusCode = deliveryStatus;
      if (deliveryStatus === 302)
        response.setHeader('location', 'https://untrusted.example/stolen');
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const providerURL = `http://127.0.0.1:${address.port}`;
  // Only transport is redirected for the fixture. Production URL validation and pinned lookup still run.
  t.mock.method(https, 'request', ((
    url: URL,
    options: https.RequestOptions,
    callback: Parameters<typeof httpRequest>[2],
  ) => {
    assert.equal(url.href, spec.outgoing.url);
    assert.ok(options.lookup);
    return httpRequest(`${providerURL}/delivery`, options, callback);
  }) as typeof https.request);
  syncBuiltinESMExports();
  const snapshots = new Map<string, ActiveChannel>([
    ['one', structuredClone(initial)],
    ['two', structuredClone(initial)],
  ]);
  type Conversation = Awaited<
    ReturnType<Parameters<typeof createPluginChannels>[1]['get']>
  >;
  const conversations = new Map<string, Conversation>();
  const scopes = new Map<string, string>();
  const sends: { scope: string; content: unknown }[] = [];
  const decisions: string[] = [];
  let pending = false;
  let releaseSend: (() => void) | undefined;
  let blockedSend: Promise<void> | undefined;
  const fakeChat = {
    async create(scope = 'web') {
      const id = randomUUID();
      scopes.set(id, scope);
      conversations.set(id, { messages: [] });
      return { id };
    },
    async get(id: string, scope = 'web') {
      assert.equal(scopes.get(id), scope);
      const value = conversations.get(id);
      assert.ok(value);
      return value;
    },
    async send(id: string, body: Record<string, unknown>, scope = 'web') {
      sends.push({ scope, content: body.content });
      await blockedSend;
      const conversation = await fakeChat.get(id, scope);
      conversation.messages.push({
        role: 'assistant',
        content: 'Controlled answer.',
      });
      if (pending)
        conversation.pending = {
          id: randomUUID(),
          name: 'write',
          arguments: { text: 'review this write' },
          status: 'waiting',
        };
      return conversation;
    },
    async decide(
      id: string,
      body: { approvalId: string; decision: 'approve' | 'deny' },
      scope = 'web',
    ) {
      const conversation = await fakeChat.get(id, scope);
      assert.equal(body.approvalId, conversation.pending?.id);
      decisions.push(body.decision);
      delete conversation.pending;
      return conversation;
    },
  };
  const actualChat = realChat
    ? await createChat(config, {
        instructions: () => '',
        tools: async () =>
          modelTools
            ? [
                {
                  name: 'write',
                  description: 'Controlled local write.',
                  parameters: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                  },
                  revision: 'fixture-v1',
                },
              ]
            : [],
        execute: async (_name, args) => {
          assert.deepEqual(args, { text: 'approved write' });
          toolExecutions++;
          return 'Write completed.';
        },
      })
    : undefined;
  await actualChat?.saveSettings({
    baseURL: `${providerURL}/v1`,
    model: 'local-model',
    apiKey: 'fake-model-key',
    systemPrompt: '',
  });
  const makeGateway = () =>
    createPluginChannels(config, actualChat || fakeChat, async (id) =>
      snapshots.get(id),
    );
  let gateway = await makeGateway();
  const database = config.db;
  cleanup = async () => {
    releaseSend?.();
    releaseDelivery?.();
    releaseModel?.();
    actualChat?.cancelPending();
    await gateway.close();
    actualChat?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
  return {
    get gateway() {
      return gateway;
    },
    config,
    snapshots,
    posts,
    sends,
    decisions,
    conversations,
    scopes,
    get modelCalls() {
      return modelCalls;
    },
    actualChat,
    blockModel() {
      blockedModel = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
    },
    releaseModel() {
      releaseModel?.();
    },
    setModelTools() {
      modelTools = true;
    },
    failContinuation() {
      failContinuation = true;
    },
    get toolExecutions() {
      return toolExecutions;
    },
    async jobs() {
      return await database.all(
        'SELECT * FROM rove_plugin_channel_job ORDER BY sequence',
      );
    },
    async thread(installation: string) {
      const row = await database.get<{ conversation: string; scope: string }>(
        'SELECT conversation, scope FROM rove_plugin_channel_thread WHERE scope LIKE $1',
        [`plugin-channel:${installation}:%`],
      );
      assert.ok(row);
      return row;
    },
    setPending() {
      pending = true;
    },
    setDeliveryStatus(value: number) {
      deliveryStatus = value;
    },
    dropDelivery() {
      dropDelivery = true;
    },
    blockSend() {
      blockedSend = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
    },
    releaseSend() {
      releaseSend?.();
    },
    blockDelivery() {
      blockedDelivery = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
    },
    releaseDelivery() {
      releaseDelivery?.();
    },
    async restart() {
      await gateway.close();
      gateway = await makeGateway();
    },
    async simulateCrashPhase(phase: string) {
      await gateway.close();
      await database.run(
        'UPDATE rove_plugin_channel_job SET status=$1, finished_at=NULL',
        [phase],
      );
      gateway = await makeGateway();
    },
  };
}

function status(expected: number) {
  return (error: unknown) =>
    error instanceof HttpError && error.status === expected;
}

function assertCompacted(job: Record<string, unknown> | undefined) {
  assert.ok(job);
  for (const field of [
    'scope',
    'actor',
    'destination',
    'thread',
    'content',
    'decision',
    'approval',
    'snapshot',
    'fingerprint',
    'conversation',
    'reply',
  ])
    assert.equal(job[field], '', field);
  assert.equal(typeof job.finished_at, 'number');
  assert.ok(Number(job.finished_at) > 0);
}

test('channel manifests admit only bounded data bindings and dashboard access rules', () => {
  for (const patch of [
    { verified: true },
    { handler: './arbitrary.js' },
    { role: 'admin' },
    { environment: ['SECRET'] },
  ])
    assert.equal(channelSpec.safeParse({ ...spec, ...patch }).success, false);
  for (const path of [
    '/__proto__/x',
    '/constructor',
    '/bad~2escape',
    'actor',
    '/',
  ])
    assert.equal(
      channelSpec.safeParse({
        ...spec,
        incoming: { ...spec.incoming, actor: path },
      }).success,
      false,
    );
  for (const url of [
    'http://example.com/send',
    'https://user:pass@example.com/send',
    'https://example.com/send?secret=one',
    'https://example.com/#secret',
  ])
    assert.equal(
      channelSpec.safeParse({ ...spec, outgoing: { ...spec.outgoing, url } })
        .success,
      false,
    );
  assert.equal(
    channelAccess.safeParse({
      tenant: 'company',
      users: ['alice'],
      admins: ['intruder'],
      destinations: ['room'],
    }).success,
    false,
  );
});

test('signed messages use the actual core chat and local model, deduplicate, and isolate installations', async (t) => {
  const f = await fixture(t, true);
  const input = event({ scope: 'web', verified: true, role: 'admin' });
  const admissions = await Promise.all(
    Array.from({ length: 8 }, () => f.gateway.handle(signed(input), 'one')),
  );
  assert.deepEqual(
    admissions.map((response) => response.status).sort(),
    [200, 200, 200, 200, 200, 200, 200, 202],
  );
  assert.equal(
    f.modelCalls,
    0,
    'ingress must acknowledge without running the model',
  );
  f.gateway.start();
  await until(async () => (await f.jobs())[0]?.status === 'sent');
  assert.deepEqual(f.posts[0], {
    room: 'room',
    thread: 'thread',
    text: 'Local model answer 1.',
  });
  assert.equal(f.modelCalls, 1);
  assertCompacted((await f.jobs())[0]);
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.posts.length, 1);
  assert.equal((await f.actualChat?.list())?.length, 0);
  assert.equal((await f.gateway.handle(signed(input), 'two')).status, 202);
  await until(async () => (await f.jobs())[1]?.status === 'sent');
  const first = await f.thread('one');
  const second = await f.thread('two');
  assert.notEqual(first.scope, second.scope);
  assert.notEqual(first.conversation, second.conversation);
  assert.ok(f.actualChat);
  await assert.rejects(
    f.actualChat.get(first.conversation, second.scope),
    status(404),
  );
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, 2);
  assert.equal(f.posts.length, 2);
  assertCompacted((await f.jobs())[0]);
});

test('accepted channel messages wait for a busy web model call and then deliver once', async (t) => {
  const f = await fixture(t, true);
  assert.ok(f.actualChat);
  f.blockModel();
  const web = await f.actualChat.create();
  const webReply = f.actualChat.send(web.id, {
    content: 'Hold the shared model while a channel message arrives.',
    requestId: randomUUID(),
  });
  await until(async () => f.modelCalls === 1);
  const input = event();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 202);
  f.gateway.start();
  let queued: Record<string, unknown> | undefined;
  await until(async () => {
    queued = (await f.jobs())[0];
    return Boolean(queued?.conversation) && queued?.status === 'pending';
  });
  assert.equal(queued?.content, input.text);
  assert.ok(queued?.snapshot);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.posts.length, 0);

  f.releaseModel();
  await webReply;
  await until(async () => (await f.jobs())[0]?.status === 'sent');
  assert.equal(f.modelCalls, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]?.text, 'Local model answer 2.');
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, 2);
  assert.equal(f.posts.length, 1);
});

test('terminal history does not limit admission and a full active queue still accepts duplicates', async (t) => {
  const f = await fixture(t);
  await f.config.db.run(
    `INSERT INTO rove_plugin_channel_job
      (id,installation,event,scope,actor,destination,thread,content,decision,approval,snapshot,fingerprint,status,finished_at)
      SELECT 'history-' || n, 'one', 'history-' || n, '', '', '', '', '', '', '', '', '',
        CASE WHEN n <= 10001 THEN 'sent' ELSE 'pending' END,
        CASE WHEN n <= 10001 THEN $1::bigint ELSE NULL END
      FROM generate_series(1, 10500) AS n`,
    [Date.now()],
  );
  const input = event();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 202);
  await assert.rejects(f.gateway.handle(signed(event()), 'one'), status(503));
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  assert.equal(
    (await f.gateway.handle(signed(event({ event: 'history-1' })), 'one'))
      .status,
    200,
  );
  assert.equal((await f.jobs()).length, 10501);
  assert.equal(f.sends.length, 0);
  assert.equal(f.posts.length, 0);
});

test('legacy channel jobs migrate once without deleting identities or pending work', async (t) => {
  const states = [
    'sent',
    'failed',
    'cancelled',
    'uncertain',
    'processing',
    'delivering',
    'pending',
    'ready',
  ];
  const f = await fixture(t, false, async (database) => {
    await database.exec(`
      CREATE TABLE rove_plugin_channel_job(
        sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id TEXT UNIQUE NOT NULL,
        installation TEXT NOT NULL, event TEXT NOT NULL, scope TEXT NOT NULL, actor TEXT NOT NULL,
        destination TEXT NOT NULL, thread TEXT NOT NULL, content TEXT NOT NULL,
        decision TEXT NOT NULL, approval TEXT NOT NULL, snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL,
        conversation TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
        UNIQUE(installation,event));
      CREATE INDEX rove_plugin_channel_queue ON rove_plugin_channel_job(status,sequence);`);
    for (const phase of states)
      await database.run(
        `INSERT INTO rove_plugin_channel_job
          (id,installation,event,scope,actor,destination,thread,content,decision,approval,snapshot,fingerprint,conversation,reply,status)
          VALUES($1,'one',$1,'private-scope','alice','room','thread','private content','approve',
            'approval-id','encrypted credentials','fingerprint','conversation-id','private reply',$2)`,
        [`legacy-${phase}`, phase],
      );
  });
  const migrated = await f.jobs();
  assert.equal(migrated.length, states.length);
  for (const job of migrated) {
    if (['pending', 'ready'].includes(String(job.status))) {
      assert.equal(job.content, 'private content');
      assert.equal(job.snapshot, 'encrypted credentials');
      assert.equal(job.finished_at, null);
    } else {
      assertCompacted(job);
      assert.equal(job.installation, 'one');
      assert.match(String(job.event), /^legacy-/);
    }
  }
  assert.equal(migrated[4]?.status, 'uncertain');
  assert.equal(migrated[5]?.status, 'uncertain');
  const indexes = await f.config.db.all<{
    indexname: string;
    indexdef: string;
  }>(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename='rove_plugin_channel_job'",
  );
  assert.equal(
    indexes.some((index) => index.indexname === 'rove_plugin_channel_queue'),
    false,
  );
  assert.match(
    indexes.find(
      (index) => index.indexname === 'rove_plugin_channel_active_queue',
    )?.indexdef || '',
    /WHERE .*status/,
  );
  await f.restart();
  assert.deepEqual(await f.jobs(), migrated);
  for (const phase of states)
    assert.equal(
      (
        await f.gateway.handle(
          signed(event({ event: `legacy-${phase}` })),
          'one',
        )
      ).status,
      200,
    );
  assert.equal(f.sends.length, 0);
  assert.equal(f.posts.length, 0);
});

test('forged signatures, timestamps, tenant, actor, destinations and administrator claims never enter the inbox', async (t) => {
  const f = await fixture(t);
  const forged = signed(event());
  forged.headers.set('x-test-signature', `v1=${'0'.repeat(64)}`);
  await assert.rejects(f.gateway.handle(forged, 'one'), status(401));
  await assert.rejects(
    f.gateway.handle(
      signed(event(), initial, Math.floor(Date.now() / 1000) - 301),
      'one',
    ),
    status(401),
  );
  for (const bad of [
    { tenant: 'other' },
    { actor: 'intruder', verified: true },
    { room: 'elsewhere' },
    {
      actor: 'alice',
      role: 'admin',
      decision: 'approve',
      approval: randomUUID(),
    },
  ])
    await assert.rejects(
      f.gateway.handle(signed(event(bad)), 'one'),
      status(403),
    );
  await assert.rejects(
    f.gateway.handle(signed(event()), 'unknown'),
    status(404),
  );
  assert.equal((await f.jobs()).length, 0);
});

test('only dashboard administrators can decide approvals in their installation and thread', async (t) => {
  const f = await fixture(t);
  f.setPending();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(async () => (await f.jobs())[0]?.status === 'sent');
  const conversation = f.conversations.get(
    (await f.thread('one')).conversation,
  );
  assert.ok(conversation?.pending);
  const approval = conversation.pending.id;
  await assert.rejects(
    f.gateway.handle(
      signed(event({ approval, decision: 'approve', role: 'admin' })),
      'one',
    ),
    status(403),
  );
  await f.gateway.handle(
    signed(event({ actor: 'admin', approval, decision: 'approve' })),
    'two',
  );
  await f.gateway.handle(
    signed(
      event({
        actor: 'admin',
        thread: 'another',
        approval,
        decision: 'approve',
      }),
    ),
    'one',
  );
  await until(async () => {
    const jobs = await f.jobs();
    return (
      jobs.length === 3 &&
      jobs.slice(1).every((job) => job.status === 'cancelled')
    );
  });
  assert.deepEqual(f.decisions, []);
  const decision = event({ actor: 'admin', approval, decision: 'approve' });
  await f.gateway.handle(signed(decision), 'one');
  await until(async () => (await f.jobs())[3]?.status === 'sent');
  assert.deepEqual(f.decisions, ['approve']);
  assert.equal((await f.gateway.handle(signed(decision), 'one')).status, 200);
  assert.deepEqual(f.decisions, ['approve']);
});

test('configuration snapshots cancel queued work and revoke delivery after a running model call', async (t) => {
  const f = await fixture(t);
  await f.gateway.handle(signed(event()), 'one');
  const first = f.snapshots.get('one');
  assert.ok(first);
  first.revision = randomUUID();
  f.gateway.start();
  await until(async () => (await f.jobs())[0]?.status === 'cancelled');
  assert.equal(f.sends.length, 0);
  f.blockSend();
  await f.gateway.handle(signed(event()), 'one');
  await until(async () => f.sends.length === 1);
  f.snapshots.delete('one');
  f.releaseSend();
  await until(async () => (await f.jobs())[1]?.status === 'cancelled');
  assert.equal(f.posts.length, 0);
});

test('uncertain dispatch is durable and neither webhook retries nor restarts replay it', async (t) => {
  const f = await fixture(t);
  f.dropDelivery();
  f.gateway.start();
  const input = event();
  await f.gateway.handle(signed(input), 'one');
  await until(async () => (await f.jobs())[0]?.status === 'uncertain');
  assert.equal(f.posts.length, 1);
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.posts.length, 1);
  assert.equal(f.sends.length, 1);
  assertCompacted((await f.jobs())[0]);
});

test('restart seals both unfinished core execution and unfinished delivery as uncertain', async (t) => {
  const f = await fixture(t);
  const input = event();
  await f.gateway.handle(signed(input), 'one');
  await f.simulateCrashPhase('processing');
  assert.equal((await f.jobs())[0]?.status, 'uncertain');
  assertCompacted((await f.jobs())[0]);
  await f.simulateCrashPhase('delivering');
  f.gateway.start();
  assert.equal((await f.jobs())[0]?.status, 'uncertain');
  assertCompacted((await f.jobs())[0]);
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.sends.length, 0);
  assert.equal(f.posts.length, 0);
});

test('private endpoints are rejected and delivery redirects are never followed', async (t) => {
  const f = await fixture(t);
  f.gateway.start();
  const state = f.snapshots.get('one');
  assert.ok(state);
  state.spec.outgoing.url = 'https://127.0.0.1/private';
  await f.gateway.handle(signed(event(), state), 'one');
  await until(async () => (await f.jobs())[0]?.status === 'failed');
  assert.equal(f.posts.length, 0);
  state.spec.outgoing.url = spec.outgoing.url;
  f.setDeliveryStatus(302);
  await f.gateway.handle(signed(event(), state), 'one');
  await until(async () => (await f.jobs())[1]?.status === 'uncertain');
  assert.equal(f.posts.length, 1);
});

test('shutdown aborts in-flight delivery and closes without replaying its uncertain effect', async (t) => {
  const f = await fixture(t);
  f.blockDelivery();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(async () => f.posts.length === 1);
  await f.gateway.close();
  f.releaseDelivery();
  assert.equal((await f.jobs())[0]?.status, 'uncertain');
  await assert.rejects(f.gateway.handle(signed(event()), 'one'), status(503));
});

test('actual core approvals execute once and administrator continuation does not repeat the tool', async (t) => {
  const f = await fixture(t, true);
  f.setModelTools();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(async () => (await f.jobs())[0]?.status === 'sent');
  const job = await f.thread('one');
  const conversation = await f.actualChat?.get(job.conversation, job.scope);
  assert.ok(conversation?.pending);
  const approval = conversation.pending.id;
  assert.match(String(f.posts[0]?.text), /approved write/);
  await assert.rejects(
    f.gateway.handle(
      signed(event({ approval, decision: ['approve'], actor: 'admin' })),
      'one',
    ),
    status(400),
  );
  f.failContinuation();
  const approved = event({ approval, decision: 'approve', actor: 'admin' });
  await f.gateway.handle(signed(approved), 'one');
  await until(async () => (await f.jobs())[1]?.status === 'sent');
  assert.match(String(f.posts[1]?.text), /Tool outcome saved/);
  assert.match(String(f.posts[1]?.text), new RegExp(approval));
  assert.match(String(f.posts[1]?.text), /decision resume/);
  assert.equal(f.toolExecutions, 1);
  assert.equal(
    (await f.actualChat?.get(job.conversation, job.scope))?.pending?.status,
    'ready',
  );
  assertCompacted((await f.jobs())[1]);
  const modelCallsAfterApproval = f.modelCalls;
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(approved), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, modelCallsAfterApproval);
  assert.equal(f.toolExecutions, 1);
  assert.equal(f.posts.length, 2);
  const resumed = event({ approval, decision: 'resume', actor: 'admin' });
  await f.gateway.handle(signed(resumed), 'one');
  await until(async () => (await f.jobs())[2]?.status === 'sent');
  assert.equal(f.toolExecutions, 1);
  assert.equal(
    (await f.actualChat?.get(job.conversation, job.scope))?.pending,
    undefined,
  );
  assertCompacted((await f.jobs())[2]);
  const modelCallsAfterResume = f.modelCalls;
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(resumed), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, modelCallsAfterResume);
  assert.equal(f.toolExecutions, 1);
  assert.equal(f.posts.length, 3);
});

test('revocation while the signed body is arriving rejects the event before persistence', async (t) => {
  const f = await fixture(t);
  const original = signed(event());
  const raw = await original.text();
  let finish: ReadableStreamDefaultController<Uint8Array> | undefined;
  const request = new Request(original.url, {
    method: 'POST',
    headers: original.headers,
    duplex: 'half',
    body: new ReadableStream({
      start(controller) {
        finish = controller;
      },
    }),
  } as RequestInit);
  const pending = f.gateway.handle(request, 'one');
  f.snapshots.delete('one');
  finish?.enqueue(Buffer.from(raw));
  finish?.close();
  await assert.rejects(pending, status(409));
  assert.equal((await f.jobs()).length, 0);
});

test('a worker storage failure stops installed ingress while core web conversations remain usable', async (t) => {
  const f = await fixture(t, true);
  const get = f.config.db.get;
  t.mock.method(f.config.db, 'get', async (sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT * FROM rove_plugin_channel_job WHERE status IN'))
      throw new Error('Private internal storage details');
    return get(sql, params);
  });
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args);
  });
  f.gateway.start();
  await until(async () => (await f.gateway.status('one')).state === 'failed');
  assert.equal(JSON.stringify(logged).includes('Private'), false);
  await assert.rejects(f.gateway.handle(signed(event()), 'one'), status(503));
  const web = await f.actualChat?.create();
  assert.ok(web);
  assert.equal((await f.actualChat?.get(web.id))?.id, web.id);
});
