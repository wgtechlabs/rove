import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError } from '../src/auth.js';
import { createChat } from '../src/chat.js';
import {
  type ActiveChannel,
  channelAccess,
  channelSpec,
  createPluginChannels,
} from '../src/plugin-channel.js';

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
async function until(predicate: () => boolean) {
  for (let n = 0; n < 120; n++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for installed channel processing.');
}
async function fixture(t: TestContext, realChat = false) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-plugin-channel-'));
  const config = {
    baseURL: origin,
    authSecret: 'local-test-auth-secret-at-least-32-characters',
    databasePath: join(dir, 'rove.sqlite'),
  };
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
  type Conversation = ReturnType<
    Parameters<typeof createPluginChannels>[1]['get']
  >;
  const conversations = new Map<string, Conversation>();
  const scopes = new Map<string, string>();
  const sends: { scope: string; content: unknown }[] = [];
  const decisions: string[] = [];
  let pending = false;
  let releaseSend: (() => void) | undefined;
  let blockedSend: Promise<void> | undefined;
  const fakeChat = {
    create(scope = 'web') {
      const id = randomUUID();
      scopes.set(id, scope);
      conversations.set(id, { messages: [] });
      return { id };
    },
    get(id: string, scope = 'web') {
      assert.equal(scopes.get(id), scope);
      const value = conversations.get(id);
      assert.ok(value);
      return value;
    },
    async send(id: string, body: Record<string, unknown>, scope = 'web') {
      sends.push({ scope, content: body.content });
      await blockedSend;
      const conversation = fakeChat.get(id, scope);
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
      const conversation = fakeChat.get(id, scope);
      assert.equal(body.approvalId, conversation.pending?.id);
      decisions.push(body.decision);
      delete conversation.pending;
      return conversation;
    },
  };
  const actualChat = realChat
    ? createChat(config, {
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
  actualChat?.saveSettings({
    baseURL: `${providerURL}/v1`,
    model: 'local-model',
    apiKey: 'fake-model-key',
    systemPrompt: '',
  });
  const makeGateway = () =>
    createPluginChannels(config, actualChat || fakeChat, (id) =>
      snapshots.get(id),
    );
  let gateway = makeGateway();
  const database = new DatabaseSync(config.databasePath);
  t.after(async () => {
    releaseSend?.();
    releaseDelivery?.();
    releaseModel?.();
    actualChat?.cancelPending();
    await gateway.close();
    actualChat?.close();
    database.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
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
    jobs() {
      return database
        .prepare('SELECT * FROM rove_plugin_channel_job ORDER BY sequence')
        .all();
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
      gateway = makeGateway();
    },
    async simulateCrashPhase(phase: string) {
      await gateway.close();
      database
        .prepare('UPDATE rove_plugin_channel_job SET status=?')
        .run(phase);
      gateway = makeGateway();
    },
  };
}

function status(expected: number) {
  return (error: unknown) =>
    error instanceof HttpError && error.status === expected;
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
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 202);
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  assert.equal(
    f.modelCalls,
    0,
    'ingress must acknowledge without running the model',
  );
  f.gateway.start();
  await until(() => f.jobs()[0]?.status === 'sent');
  assert.deepEqual(f.posts[0], {
    room: 'room',
    thread: 'thread',
    text: 'Local model answer 1.',
  });
  assert.equal(f.modelCalls, 1);
  assert.equal(f.actualChat?.list().length, 0);
  assert.equal((await f.gateway.handle(signed(input), 'two')).status, 202);
  await until(() => f.jobs()[1]?.status === 'sent');
  assert.notEqual(f.jobs()[0]?.scope, f.jobs()[1]?.scope);
  assert.notEqual(f.jobs()[0]?.conversation, f.jobs()[1]?.conversation);
  assert.throws(
    () =>
      f.actualChat?.get(
        String(f.jobs()[0]?.conversation),
        String(f.jobs()[1]?.scope),
      ),
    status(404),
  );
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  assert.equal(f.modelCalls, 2);
});

test('accepted channel messages wait for a busy web model call and then deliver once', async (t) => {
  const f = await fixture(t, true);
  assert.ok(f.actualChat);
  f.blockModel();
  const web = f.actualChat.create();
  const webReply = f.actualChat.send(web.id, {
    content: 'Hold the shared model while a channel message arrives.',
    requestId: randomUUID(),
  });
  await until(() => f.modelCalls === 1);
  const input = event();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 202);
  f.gateway.start();
  await until(() => Boolean(f.jobs()[0]?.conversation));
  assert.equal(f.jobs()[0]?.status, 'pending');
  assert.equal(f.jobs()[0]?.content, input.text);
  assert.ok(f.jobs()[0]?.snapshot);
  assert.equal(f.modelCalls, 1);
  assert.equal(f.posts.length, 0);

  f.releaseModel();
  await webReply;
  await until(() => f.jobs()[0]?.status === 'sent');
  assert.equal(f.modelCalls, 2);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0]?.text, 'Local model answer 2.');
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.modelCalls, 2);
  assert.equal(f.posts.length, 1);
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
  assert.equal(f.jobs().length, 0);
});

test('only dashboard administrators can decide approvals in their installation and thread', async (t) => {
  const f = await fixture(t);
  f.setPending();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(() => f.jobs()[0]?.status === 'sent');
  const conversation = f.conversations.get(String(f.jobs()[0]?.conversation));
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
  await until(
    () =>
      f.jobs().length === 3 &&
      f
        .jobs()
        .slice(1)
        .every((job) => job.status === 'cancelled'),
  );
  assert.deepEqual(f.decisions, []);
  const decision = event({ actor: 'admin', approval, decision: 'approve' });
  await f.gateway.handle(signed(decision), 'one');
  await until(() => f.jobs()[3]?.status === 'sent');
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
  await until(() => f.jobs()[0]?.status === 'cancelled');
  assert.equal(f.sends.length, 0);
  f.blockSend();
  await f.gateway.handle(signed(event()), 'one');
  await until(() => f.sends.length === 1);
  f.snapshots.delete('one');
  f.releaseSend();
  await until(() => f.jobs()[1]?.status === 'cancelled');
  assert.equal(f.posts.length, 0);
});

test('uncertain dispatch is durable and neither webhook retries nor restarts replay it', async (t) => {
  const f = await fixture(t);
  f.dropDelivery();
  f.gateway.start();
  const input = event();
  await f.gateway.handle(signed(input), 'one');
  await until(() => f.jobs()[0]?.status === 'uncertain');
  assert.equal(f.posts.length, 1);
  await f.restart();
  f.gateway.start();
  assert.equal((await f.gateway.handle(signed(input), 'one')).status, 200);
  await delay(150);
  assert.equal(f.posts.length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.jobs()[0]?.snapshot, '');
});

test('restart seals both unfinished core execution and unfinished delivery as uncertain', async (t) => {
  const f = await fixture(t);
  const input = event();
  await f.gateway.handle(signed(input), 'one');
  await f.simulateCrashPhase('processing');
  assert.equal(f.jobs()[0]?.status, 'uncertain');
  await f.simulateCrashPhase('delivering');
  f.gateway.start();
  assert.equal(f.jobs()[0]?.status, 'uncertain');
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
  await until(() => f.jobs()[0]?.status === 'failed');
  assert.equal(f.posts.length, 0);
  state.spec.outgoing.url = spec.outgoing.url;
  f.setDeliveryStatus(302);
  await f.gateway.handle(signed(event(), state), 'one');
  await until(() => f.jobs()[1]?.status === 'uncertain');
  assert.equal(f.posts.length, 1);
});

test('shutdown aborts in-flight delivery and closes without replaying its uncertain effect', async (t) => {
  const f = await fixture(t);
  f.blockDelivery();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(() => f.posts.length === 1);
  await f.gateway.close();
  f.releaseDelivery();
  assert.equal(f.jobs()[0]?.status, 'uncertain');
  await assert.rejects(f.gateway.handle(signed(event()), 'one'), status(503));
});

test('actual core approvals execute once and administrator continuation does not repeat the tool', async (t) => {
  const f = await fixture(t, true);
  f.setModelTools();
  f.gateway.start();
  await f.gateway.handle(signed(event()), 'one');
  await until(() => f.jobs()[0]?.status === 'sent');
  const job = f.jobs()[0];
  assert.ok(job);
  const conversation = f.actualChat?.get(
    String(job.conversation),
    String(job.scope),
  );
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
  await until(() => f.jobs()[1]?.status === 'sent');
  assert.match(String(f.posts[1]?.text), /Tool outcome saved/);
  assert.match(String(f.posts[1]?.text), new RegExp(approval));
  assert.match(String(f.posts[1]?.text), /decision resume/);
  assert.equal(f.toolExecutions, 1);
  assert.equal(
    f.actualChat?.get(String(job.conversation), String(job.scope)).pending
      ?.status,
    'ready',
  );
  assert.equal((await f.gateway.handle(signed(approved), 'one')).status, 200);
  await f.gateway.handle(
    signed(event({ approval, decision: 'resume', actor: 'admin' })),
    'one',
  );
  await until(() => f.jobs()[2]?.status === 'sent');
  assert.equal(f.toolExecutions, 1);
  assert.equal(
    f.actualChat?.get(String(job.conversation), String(job.scope)).pending,
    undefined,
  );
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
  assert.equal(f.jobs().length, 0);
});

test('a worker storage failure stops installed ingress while core web conversations remain usable', async (t) => {
  const f = await fixture(t, true);
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('SELECT * FROM rove_plugin_channel_job WHERE status IN'))
        throw new Error('Private internal storage details');
      return prepare.call(this, sql);
    },
  );
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args);
  });
  f.gateway.start();
  await until(() => f.gateway.status('one').state === 'failed');
  assert.equal(JSON.stringify(logged).includes('Private'), false);
  await assert.rejects(f.gateway.handle(signed(event()), 'one'), status(503));
  const web = f.actualChat?.create();
  assert.ok(web);
  assert.equal(f.actualChat?.get(web.id).id, web.id);
});
