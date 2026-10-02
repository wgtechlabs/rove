import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../src/app.js';
import { HttpError } from '../src/auth.js';
import { createChannels } from '../src/channels.js';
import { createChat } from '../src/chat.js';

const origin = 'https://rove.example';
function configFor(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-channel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    baseURL: origin,
    authSecret: 'local-test-auth-secret-at-least-32-characters',
    setupSecret: 'local-test-setup-secret-at-least-32-characters',
    databasePath: join(dir, 'rove.sqlite'),
  };
}

test('an optional channel initialization failure leaves setup, admin and web chat usable and can be retried', async (t) => {
  const config = configFor(t);
  const exec = DatabaseSync.prototype.exec;
  let fail = true;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (fail && sql.includes('rove_slack_job'))
        throw new Error(
          'Simulated failure containing private provider details',
        );
      return exec.call(this, sql);
    },
  );
  const app = await createApplication(config);
  t.after(() => app.close());
  let cookie = '';
  const request = (path: string, body?: unknown) =>
    app.fetch(
      new Request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  assert.equal((await request('/health')).status, 200);
  const account = {
    setupSecret: config.setupSecret,
    name: 'Local admin',
    email: 'admin@example.com',
    password: 'local-test-password-12345',
  };
  assert.equal((await request('/api/setup', account)).status, 201);
  const login = await request('/api/auth/sign-in/email', account);
  assert.equal(login.status, 200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const unavailable = (await (await request('/api/admin/slack')).json()) as {
    health: { state: string; message: string };
  };
  assert.equal(unavailable.health.state, 'failed');
  assert.equal(
    JSON.stringify(unavailable).includes('private provider details'),
    false,
  );
  const conversation = await request('/api/admin/conversations', {});
  assert.equal(conversation.status, 201);
  const { id } = (await conversation.json()) as { id: string };
  assert.equal((await request(`/api/admin/conversations/${id}`)).status, 200);
  fail = false;
  const repaired = await request('/api/admin/slack', {
    enabled: false,
    allowDM: false,
    allowedUsers: [],
    allowedChannels: [],
    adminUsers: [],
  });
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).health.state, 'ready');
});

test('unexpected channel worker failures stop its ingress without stopping web conversations', async (t) => {
  const config = configFor(t);
  const chat = createChat(config);
  const channels = createChannels(config, chat);
  t.after(async () => {
    await channels.close();
    chat.close();
  });
  const prepare = DatabaseSync.prototype.prepare;
  let fail = true;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      if (fail && sql.includes('SELECT job.*'))
        throw new Error('Worker storage failed');
      return prepare.call(this, sql);
    },
  );
  t.mock.method(console, 'error', () => {});
  channels.start();
  for (let i = 0; i < 50 && channels.status().state !== 'failed'; i++)
    await delay(20);
  assert.equal(channels.status().state, 'failed');
  const conversation = chat.create();
  assert.equal(chat.get(conversation.id).id, conversation.id);
  await assert.rejects(
    channels.handle(
      new Request(`${origin}/api/slack/events`, { method: 'POST' }),
    ),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
  fail = false;
  await channels.save({
    enabled: false,
    allowDM: false,
    allowedUsers: [],
    allowedChannels: [],
    adminUsers: [],
  });
  assert.equal(channels.status().state, 'ready');
});

test('the versioned channel boundary rejects unknown channels and has no arbitrary scope entry point', async (t) => {
  const config = configFor(t);
  const chat = createChat(config);
  const channels = createChannels(config, chat);
  t.after(async () => {
    await channels.close();
    chat.close();
  });
  assert.equal(channels.status().apiVersion, 1);
  assert.throws(
    () => channels.settings('unknown'),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  await assert.rejects(
    channels.save({}, 'unknown'),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  await assert.rejects(
    channels.handle(
      new Request(`${origin}/api/unknown/events`, {
        method: 'POST',
        body: JSON.stringify({ scope: 'web', role: 'admin' }),
      }),
    ),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  channels.cancelPending();
  await assert.rejects(
    channels.save({}),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
  assert.equal(channels.status().state, 'stopped');
});
