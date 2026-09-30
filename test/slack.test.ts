import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/app.js';
import { HttpError } from '../src/auth.js';
import { createSlack, MAX_SLACK_BODY } from '../src/slack.js';

const nativeFetch = globalThis.fetch;
const secret = 'fake-slack-signing-secret';
const token = 'xoxb-local-test-token';
const origin = 'https://rove.example';
const settings = {
  enabled: true,
  botToken: token,
  signingSecret: secret,
  allowedUsers: ['UALICE', 'UADMIN'],
  allowedChannels: ['CROOM'],
  adminUsers: ['UADMIN'],
  allowDM: true,
};
type Conversation = {
  messages: { role: string; content: string }[];
  pending?: {
    id: string;
    name: string;
    arguments: unknown;
    status: string;
    detail?: string;
    description?: string;
  };
};

function signed(
  body: unknown,
  interactive = false,
  stamp = Math.floor(Date.now() / 1000),
) {
  const raw = interactive
    ? new URLSearchParams({ payload: JSON.stringify(body) }).toString()
    : JSON.stringify(body);
  return new Request(
    origin + (interactive ? '/api/slack/interactivity' : '/api/slack/events'),
    {
      method: 'POST',
      headers: {
        'content-type': interactive
          ? 'application/x-www-form-urlencoded'
          : 'application/json',
        'x-slack-request-timestamp': String(stamp),
        'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:${stamp}:${raw}`).digest('hex')}`,
      },
      body: raw,
    },
  );
}
function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'event_callback',
    team_id: 'TTEAM',
    event_id: id,
    event: {
      type: 'app_mention',
      user: 'UALICE',
      channel: 'CROOM',
      ts: '1000.000001',
      text: '<@UBOT> Hello',
      ...overrides,
    },
  };
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail('Timed out waiting for local Slack processing.');
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-slack-'));
  const config = {
    baseURL: origin,
    authSecret: 'local-test-auth-secret-at-least-32-characters',
    databasePath: join(dir, 'rove.sqlite'),
  };
  const conversations = new Map<string, Conversation>();
  const scopes = new Map<string, string>();
  const sends: { id: string; body: Record<string, unknown>; scope?: string }[] =
    [];
  const decisions: { approvalId: string; decision: string }[] = [];
  let wait: Promise<void> | undefined;
  let needsApproval = false;
  let approvalDetail: string | undefined;
  const chat = {
    create(scope = 'web') {
      const id = `conversation-${conversations.size}`;
      conversations.set(id, { messages: [] });
      scopes.set(id, scope);
      return { id };
    },
    get(id: string, scope = 'web') {
      assert.equal(scopes.get(id), scope);
      return conversations.get(id) as Conversation;
    },
    async send(id: string, body: Record<string, unknown>, scope?: string) {
      sends.push({ id, body, scope });
      await wait;
      const result = chat.get(id, scope);
      result.messages.push({
        role: 'assistant',
        content: 'Local fake Slack reply.',
      });
      if (needsApproval)
        result.pending = {
          id: 'approval-1',
          name: 'test_write',
          arguments: { target: 'test' },
          status: 'waiting',
          ...(approvalDetail ? { detail: approvalDetail } : {}),
        };
      return result;
    },
    async decide(
      id: string,
      body: { approvalId: string; decision: 'approve' | 'deny' },
      scope?: string,
    ) {
      decisions.push(body);
      const result = chat.get(id, scope);
      delete result.pending;
      result.messages.push({
        role: 'assistant',
        content: 'Decision processed.',
      });
      return result;
    },
  };
  const posts: Record<string, unknown>[] = [];
  let failPost: 'network' | 'rate' | 'rejected' | undefined;
  const originalFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.ok(String(url).startsWith('https://slack.com/api/'));
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        `Bearer ${token}`,
      );
      if (String(url).endsWith('auth.test'))
        return Response.json({
          ok: true,
          team_id: 'TTEAM',
          user_id: 'UBOT',
          bot_id: 'BBOT',
        });
      posts.push(JSON.parse(String(init?.body)));
      if (failPost === 'network') throw new Error('Simulated network loss.');
      if (failPost === 'rejected')
        return Response.json({ ok: false, error: 'channel_not_found' });
      if (failPost === 'rate') {
        failPost = undefined;
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '1' },
        });
      }
      return Response.json({ ok: true, ts: '1001.000001' });
    },
  );
  let slack = createSlack(config, chat);
  await slack.save(settings);
  t.after(async () => {
    await slack.close();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    chat,
    posts,
    sends,
    decisions,
    conversations,
    get slack() {
      return slack;
    },
    async restart() {
      await slack.close();
      slack = createSlack(config, chat);
    },
    hold(value: Promise<void> | undefined) {
      wait = value;
    },
    approval(detail?: string) {
      needsApproval = true;
      approvalDetail = detail;
    },
    fail(value: typeof failPost) {
      failPost = value;
    },
  };
}

test('Slack configuration encrypts credentials and validates signed challenges without browser Origin', async (t) => {
  const f = await fixture(t);
  const visible = f.slack.settings();
  assert.equal(visible.teamId, 'TTEAM');
  assert.equal(JSON.stringify(visible).includes(token), false);
  const db = new DatabaseSync(f.config.databasePath);
  const saved = String(
    db.prepare('SELECT value FROM rove_slack_settings').get()?.value,
  );
  db.close();
  assert.equal(saved.includes(token), false);
  assert.equal(saved.includes(secret), false);
  const response = await f.slack.handle(
    signed({ type: 'url_verification', challenge: 'local-challenge' }),
  );
  assert.deepEqual(await response.json(), { challenge: 'local-challenge' });
  await assert.rejects(
    f.slack.handle(signed(event('EOLD'), false, 1)),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
  const altered = signed(event('EBAD'));
  altered.headers.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
  await assert.rejects(
    f.slack.handle(altered),
    (e: unknown) => e instanceof HttpError && e.status === 401,
  );
});

test('Slack acknowledges before execution, deduplicates and restarts a durable inbox', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.slack.handle(signed(event('EONE')))).status, 200);
  await f.slack.handle(signed(event('EONE')));
  assert.equal(f.sends.length, 0);
  await f.restart();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.slack.start();
  await until(() => f.sends.length === 1);
  assert.equal((await f.slack.handle(signed(event('EONE')))).status, 200);
  assert.equal(f.posts.length, 0);
  release();
  await until(() => f.posts.length === 1);
  assert.equal(f.sends[0]?.scope, 'slack:TTEAM:CROOM:1000.000001');
  assert.equal(f.posts[0]?.thread_ts, '1000.000001');
  assert.equal(f.posts[0]?.reply_broadcast, false);
  await f.restart();
  f.slack.start();
  await delay(350);
  assert.equal(f.sends.length, 1);
  assert.equal(f.posts.length, 1);
});

test('Slack filters denied users/channels, other workspaces, shared channels, bots and group DMs', async (t) => {
  const f = await fixture(t);
  const denied = [
    event('EUSER', { user: 'UOTHER' }),
    event('EROOM', { channel: 'COTHER' }),
    event('EBOT', { bot_id: 'BBOT' }),
    event('ESELF', { user: 'UBOT' }),
    event('EEDIT', { subtype: 'message_changed' }),
    event('EGROUP', { type: 'message', channel_type: 'mpim' }),
    { ...event('ESHARED'), is_ext_shared_channel: true },
    { ...event('ETEAM'), team_id: 'TOTHER' },
  ];
  for (const item of denied)
    assert.equal((await f.slack.handle(signed(item))).status, 200);
  f.slack.start();
  await delay(350);
  assert.equal(f.sends.length, 0);
  await f.slack.handle(
    signed(
      event('EDM', { type: 'message', channel_type: 'im', channel: 'DALICE' }),
    ),
  );
  await until(() => f.posts.length === 1);
  assert.equal(f.sends[0]?.scope, 'slack:TTEAM:DALICE:1000.000001');
});

test('Slack approval buttons require explicit admin and preserve originating thread', async (t) => {
  const f = await fixture(t);
  f.approval();
  await f.slack.handle(signed(event('EAPPROVE')));
  f.slack.start();
  await until(() => f.posts.length === 1);
  const blocks = f.posts[0]?.blocks as { elements?: { value: string }[] }[];
  const value = blocks[1]?.elements?.[0]?.value;
  assert.ok(value);
  const interaction = (user: string, channel = 'CROOM') => ({
    type: 'block_actions',
    team: { id: 'TTEAM' },
    user: { id: user },
    channel: { id: channel },
    actions: [{ action_id: 'rove_approve', value }],
  });
  await f.slack.handle(signed(interaction('UALICE'), true));
  await f.slack.handle(signed(interaction('UADMIN', 'COTHER'), true));
  await delay(350);
  assert.equal(f.decisions.length, 0);
  await f.slack.handle(signed(interaction('UADMIN'), true));
  await f.slack.handle(signed(interaction('UADMIN'), true));
  await until(() => f.posts.length === 2);
  assert.deepEqual(f.decisions, [
    { approvalId: 'approval-1', decision: 'approve' },
  ]);
  assert.equal(f.posts[1]?.channel, 'CROOM');
  assert.equal(f.posts[1]?.thread_ts, '1000.000001');
});

test('Slack configuration change revokes queued work and cancellation rejects new ingress', async (t) => {
  const f = await fixture(t);
  await f.slack.handle(signed(event('ECANCEL')));
  await f.slack.save({
    ...settings,
    enabled: false,
    botToken: '',
    signingSecret: '',
  });
  f.slack.start();
  await delay(350);
  assert.equal(f.sends.length, 0);
  f.slack.cancelPending();
  await assert.rejects(
    f.slack.handle(signed(event('ELATE'))),
    (e: unknown) => e instanceof HttpError && e.status === 503,
  );
});

test('Slack retains an uncertain outgoing delivery without blindly resending on restart', async (t) => {
  const f = await fixture(t);
  f.fail('network');
  await f.slack.handle(signed(event('EUNCERTAIN')));
  f.slack.start();
  await until(() =>
    f.slack.settings().failures.some((row) => row.status === 'uncertain'),
  );
  await f.restart();
  f.fail(undefined);
  f.slack.start();
  await delay(350);
  assert.equal(f.posts.length, 1);
  assert.equal(f.sends.length, 1);
});

test('Slack honors rate limits using the saved reply without rerunning the agent', async (t) => {
  const f = await fixture(t);
  f.fail('rate');
  await f.slack.handle(signed(event('ERATE')));
  f.slack.start();
  await until(() => f.posts.length === 2);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.posts[0], f.posts[1]);
});

test('Slack threads remain isolated while follow-ups reuse the original scoped conversation', async (t) => {
  const f = await fixture(t);
  await f.slack.handle(signed(event('ETHREAD1')));
  await f.slack.handle(signed(event('ETHREAD2', { ts: '1002.000001' })));
  await f.slack.handle(
    signed(event('EFOLLOW', { ts: '1003.000001', thread_ts: '1000.000001' })),
  );
  f.slack.start();
  await until(() => f.posts.length === 3);
  assert.equal(f.sends[0]?.id, f.sends[2]?.id);
  assert.notEqual(f.sends[0]?.id, f.sends[1]?.id);
  assert.notEqual(f.sends[0]?.body.requestId, f.sends[2]?.body.requestId);
});

test('Slack shutdown aborts a configuration probe before closing its storage', async (t) => {
  const f = await fixture(t);
  let started = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      started = true;
      await new Promise((_, reject) =>
        init.signal?.addEventListener(
          'abort',
          () => reject(new Error('Cancelled')),
          { once: true },
        ),
      );
      throw new Error('Unexpected resolution');
    },
  );
  const saving = f.slack.save(settings);
  const rejection = assert.rejects(
    saving,
    (error: unknown) => error instanceof HttpError,
  );
  await until(() => started);
  f.slack.cancelPending();
  await rejection;
});

test('Slack approval shows immutable detailed previews in full and only offers denial when too large', async (t) => {
  const f = await fixture(t);
  const detail = `Exact proposed change: ${'test proposal '.repeat(300)}`;
  f.approval(detail);
  await f.slack.handle(signed(event('EDETAIL')));
  f.slack.start();
  await until(() => f.posts.length === 1);
  assert.ok(String(f.posts[0]?.text).includes(detail));
  const blocks = f.posts[0]?.blocks as {
    type: string;
    text?: { text: string };
  }[];
  assert.ok(
    blocks
      .filter((block) => block.type === 'section')
      .map((block) => block.text?.text)
      .join('')
      .includes(detail),
  );
  f.approval('界'.repeat(16000));
  await f.slack.handle(signed(event('EHUGE', { ts: '1004.000001' })));
  await until(() => f.posts.length === 2);
  const huge = f.posts[1]?.blocks as {
    type: string;
    elements?: { action_id: string }[];
  }[];
  assert.deepEqual(
    huge
      .find((block) => block.type === 'actions')
      ?.elements?.map((button) => button.action_id),
    ['rove_deny'],
  );
});

test('real application routes a signed Slack event through shared chat without exposing it in web history', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rove-slack-app-'));
  const config = {
    baseURL: origin,
    authSecret: 'local-test-auth-secret-at-least-32-characters',
    setupSecret: 'local-test-setup-secret-at-least-32-characters',
    databasePath: join(dir, 'rove.sqlite'),
  };
  const posts: Record<string, unknown>[] = [];
  let modelCalls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, init: RequestInit) => {
      if (String(url) === 'https://slack.com/api/auth.test')
        return Response.json({
          ok: true,
          team_id: 'TTEAM',
          user_id: 'UBOT',
          bot_id: 'BBOT',
        });
      if (String(url) === 'https://slack.com/api/chat.postMessage') {
        posts.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true, ts: '1001.000001' });
      }
      assert.equal(String(url), 'https://provider.example/v1/chat/completions');
      modelCalls++;
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Shared runtime test answer.',
            },
          },
        ],
      });
    },
  );
  const app = await createApplication(config);
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = {
    name: 'Local admin',
    email: 'admin@example.com',
    password: 'local-test-password-12345',
    setupSecret: config.setupSecret,
  };
  let cookie = '';
  function admin(path: string, body?: unknown) {
    return app.fetch(
      new Request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  }
  assert.equal((await admin('/api/setup', account)).status, 201);
  const login = await admin('/api/auth/sign-in/email', account);
  assert.equal(login.status, 200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.equal(
    (
      await admin('/api/admin/settings', {
        baseURL: 'https://provider.example/v1',
        model: 'fake-model',
        systemPrompt: 'Company test instructions.',
        apiKey: 'fake-model-key',
      })
    ).status,
    200,
  );
  assert.equal((await admin('/api/admin/slack', settings)).status, 200);
  const spoofedAdmin = new Request(`${origin}/api/admin/slack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(settings),
  });
  assert.equal((await app.fetch(spoofedAdmin)).status, 403);
  assert.equal(
    (
      await app.fetch(
        signed({ type: 'url_verification', challenge: 'app-route-challenge' }),
      )
    ).status,
    200,
  );
  assert.equal((await app.fetch(signed(event('EREALAPP')))).status, 200);
  await until(() => posts.length === 1);
  assert.equal(modelCalls, 1);
  assert.equal(posts[0]?.text, 'Shared runtime test answer.');
  const history = (await (await admin('/api/admin/conversations')).json()) as {
    conversations: unknown[];
  };
  assert.equal(history.conversations.length, 0);
  assert.equal((await app.fetch(signed(event('EREALAPP')))).status, 200);
  await delay(300);
  assert.equal(modelCalls, 1);
});

test('Slack offers a durable Continue reply action after an approved tool finishes but model continuation fails', async (t) => {
  const f = await fixture(t);
  f.approval();
  let executions = 0;
  let continuations = 0;
  const decide = f.chat.decide;
  f.chat.decide = async (id, body, scope) => {
    const current = f.chat.get(id, scope);
    if (current.pending?.status === 'waiting') {
      executions++;
      current.pending.status = 'ready';
      throw new HttpError(502, 'Local model continuation failed.');
    }
    assert.equal(current.pending?.status, 'ready');
    continuations++;
    if (continuations === 1) throw new HttpError(502, 'Still unavailable.');
    return decide(id, body, scope);
  };
  await f.slack.handle(signed(event('ERESUME')));
  f.slack.start();
  await until(() => f.posts.length === 1);
  function action(
    post: Record<string, unknown>,
    actionId: string,
    actionTs: string,
  ) {
    const blocks = post.blocks as { elements?: { value: string }[] }[];
    return {
      type: 'block_actions',
      team: { id: 'TTEAM' },
      user: { id: 'UADMIN' },
      channel: { id: 'CROOM' },
      actions: [
        {
          action_id: actionId,
          action_ts: actionTs,
          value: blocks.at(-1)?.elements?.[0]?.value,
        },
      ],
    };
  }
  await f.slack.handle(
    signed(
      action(
        f.posts[0] as Record<string, unknown>,
        'rove_approve',
        '1001.000001',
      ),
      true,
    ),
  );
  await until(() => f.posts.length === 2);
  assert.ok(
    String(f.posts[1]?.text).includes('without running the tool again'),
  );
  await f.restart();
  f.slack.start();
  const resume = action(
    f.posts[1] as Record<string, unknown>,
    'rove_resume',
    '1002.000001',
  );
  await f.slack.handle(signed(resume, true));
  await f.slack.handle(signed(resume, true));
  await f.slack.handle(
    signed(
      action(
        f.posts[1] as Record<string, unknown>,
        'rove_resume',
        '1002.000002',
      ),
      true,
    ),
  );
  await until(() => f.posts.length === 3);
  await delay(350);
  assert.equal(continuations, 1);
  const retry = action(
    f.posts[2] as Record<string, unknown>,
    'rove_resume',
    '1003.000001',
  );
  await f.slack.handle(signed(retry, true));
  await f.slack.handle(
    signed(
      action(
        f.posts[2] as Record<string, unknown>,
        'rove_resume',
        '1003.000002',
      ),
      true,
    ),
  );
  await until(() => f.posts.length === 4);
  await delay(350);
  assert.equal(f.posts.length, 4);
  assert.equal(continuations, 2);
  assert.equal(executions, 1);
  assert.equal(f.decisions.length, 1);
});

test('a rate-limited thread does not block another thread or allow its own follow-up to overtake', async (t) => {
  const f = await fixture(t);
  f.fail('rate');
  await f.slack.handle(signed(event('ERATEFIRST')));
  await f.slack.handle(
    signed(
      event('ERATEFOLLOW', {
        ts: '1001.000001',
        thread_ts: '1000.000001',
        text: 'A follow-up in the delayed thread',
      }),
    ),
  );
  await f.slack.handle(
    signed(
      event('EOTHERTHREAD', { ts: '2000.000001', text: 'A separate thread' }),
    ),
  );
  f.slack.start();
  await until(() => f.posts.length >= 2);
  assert.equal(f.posts[0]?.thread_ts, '1000.000001');
  assert.equal(f.posts[1]?.thread_ts, '2000.000001');
  assert.deepEqual(
    f.sends.map((send) => send.body.content),
    ['Hello', 'A separate thread'],
  );
  await until(() => f.posts.length === 4);
  assert.deepEqual(f.posts[2], f.posts[0]);
  assert.equal(f.posts[3]?.thread_ts, '1000.000001');
  assert.deepEqual(
    f.sends.map((send) => send.body.content),
    ['Hello', 'A separate thread', 'A follow-up in the delayed thread'],
  );
  assert.equal(f.sends[0]?.id, f.sends[2]?.id);
});

test('Slack scrubs delivered payloads and expires terminal retry records without pruning active work', async (t) => {
  const f = await fixture(t);
  await f.slack.handle(signed(event('ERETAIN')));
  f.slack.start();
  await until(() => f.posts.length === 1);
  await f.restart();
  const db = new DatabaseSync(f.config.databasePath);
  t.after(() => db.close());
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT content,reply FROM rove_slack_job WHERE id='ERETAIN'")
        .get(),
    },
    { content: '', reply: '' },
  );
  await f.slack.handle(signed(event('ERETAIN')));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM rove_slack_job').get()?.n,
    1,
  );
  for (const status of [
    'failed',
    'uncertain',
    'cancelled',
    'pending',
    'ready',
  ]) {
    db.prepare(`INSERT INTO rove_slack_job(id,scope,channel,thread,user,content,status,finished_at)
      VALUES(?, 'test', 'CROOM', '1000.000001', 'UALICE', 'saved input', ?, ?)`).run(
      status,
      status,
      Date.now(),
    );
  }
  const later = Date.now() + 8 * 86400000;
  t.mock.method(Date, 'now', () => later);
  await f.slack.handle(signed(event('EFRESH')));
  assert.deepEqual(
    db
      .prepare('SELECT id FROM rove_slack_job ORDER BY id')
      .all()
      .map((row) => row.id),
    ['EFRESH', 'pending', 'ready'],
  );
});

test('application startup rolls back every opened database when a service fails to initialize', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rove-startup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  const open = new Set<DatabaseSync>();
  let failure = '';
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      open.add(this);
      if (sql.includes(failure))
        throw new Error('Simulated initialization failure');
      return exec.call(this, sql);
    },
  );
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    open.delete(this);
    return close.call(this);
  });
  for (const stage of [
    'rove_extension',
    'rove_aip',
    'ALTER TABLE rove_conversation',
    'rove_run',
    'rove_slack_job',
  ]) {
    failure = stage;
    await assert.rejects(
      createApplication({
        baseURL: origin,
        authSecret: 'local-test-auth-secret-at-least-32-characters',
        setupSecret: 'local-test-setup-secret-at-least-32-characters',
        databasePath: join(dir, `${stage.replaceAll(' ', '-')}.sqlite`),
      }),
      /Simulated initialization failure/,
    );
    assert.equal(open.size, 0, stage);
  }
});

test('HTTP ingress admits signed large Slack interactions while preserving route-specific body limits', async (t) => {
  const fetchHTTP = nativeFetch;
  const f = await fixture(t);
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const child = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      PORT: String(address.port),
      ROVE_URL: origin,
      BETTER_AUTH_SECRET: f.config.authSecret,
      ROVE_DATABASE_PATH: f.config.databasePath,
      ROVE_SETUP_SECRET: 'local-http-test-setup-secret-at-least-32',
    },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    let healthy = false;
    for (let n = 0; n < 100; n++) {
      try {
        healthy = (await fetchHTTP(`${base}/health`)).ok;
      } catch {}
      if (healthy) break;
      await delay(25);
    }
    assert.ok(healthy, 'The actual HTTP server must start');
    const text = 'Review this proposed change. '.repeat(650);
    const request = signed(
      {
        type: 'block_actions',
        team: { id: 'TTEAM' },
        user: { id: 'UADMIN' },
        channel: { id: 'CROOM' },
        actions: [
          {
            action_id: 'rove_approve',
            value: JSON.stringify({ job: 'unknown', approval: 'unknown' }),
          },
        ],
        message: {
          text,
          blocks: [{ type: 'section', text: { type: 'plain_text', text } }],
        },
      },
      true,
    );
    const raw = await request.text();
    assert.ok(Buffer.byteLength(raw) > 32768);
    assert.ok(Buffer.byteLength(raw) < MAX_SLACK_BODY);
    const send = (path: string, body: string, headers: Headers) =>
      fetchHTTP(base + path, { method: 'POST', headers, body });
    assert.equal(
      (await send('/api/slack/interactivity', raw, request.headers)).status,
      200,
    );
    const bad = new Headers(request.headers);
    bad.set('x-slack-signature', `v0=${'0'.repeat(64)}`);
    assert.equal(
      (await send('/api/slack/interactivity', raw, bad)).status,
      401,
    );
    assert.equal(
      (await send('/api/admin/settings', raw, request.headers)).status,
      413,
    );
    assert.equal(
      (
        await send(
          '/api/slack/interactivity',
          'x'.repeat(MAX_SLACK_BODY + 1),
          request.headers,
        )
      ).status,
      413,
    );
    assert.equal(
      (
        await send(
          '/api/slack/events',
          'x'.repeat(MAX_SLACK_BODY + 1),
          request.headers,
        )
      ).status,
      413,
    );
  } finally {
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0);
  }
});
