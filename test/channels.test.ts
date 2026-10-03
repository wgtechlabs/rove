import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { createApplication } from '../src/app.js';
import { HttpError } from '../src/auth.js';
import { createChannels } from '../src/channels.js';
import { createChat } from '../src/chat.js';
import { testConfig, testRuntime } from './storage.js';

const origin = 'https://rove.example';
test('an optional channel initialization failure leaves setup, admin and web chat usable and can be retried', async (t) => {
  let app: Awaited<ReturnType<typeof createApplication>>;
  t.after(() => app?.close());
  const config = { ...(await testConfig(t)), baseURL: origin };
  const query = Client.prototype.query;
  let fail = true;
  t.mock.method(
    Client.prototype,
    'query',
    function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (
        fail &&
        (sql.includes('rove_slack_job') ||
          sql.includes('rove_plugin_channel_job'))
      )
        throw new Error(
          'Simulated failure containing private provider details',
        );
      return Reflect.apply(query, this, args);
    },
  );
  app = await createApplication(config);
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
  const installation = '00000000-0000-4000-8000-000000000001';
  const installed = await request(`/api/admin/plugins/${installation}/channel`);
  assert.deepEqual(await installed.json(), { state: 'failed', jobs: [] });
  assert.equal(
    (await request(`/api/channels/${installation}/events`, {})).status,
    503,
  );
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
  let chat: Awaited<ReturnType<typeof createChat>>;
  let channels: Awaited<ReturnType<typeof createChannels>>;
  t.after(async () => {
    await channels?.close();
    chat?.close();
  });
  const config = await testRuntime(t);
  chat = await createChat(config);
  channels = await createChannels(config, chat);
  const get = config.db.get;
  let fail = true;
  t.mock.method(config.db, 'get', async (sql: string, params?: unknown[]) => {
    if (fail && sql.includes('SELECT job.*'))
      throw new Error('Worker storage failed');
    return get(sql, params);
  });
  t.mock.method(console, 'error', () => {});
  channels.start();
  for (let i = 0; i < 50 && channels.status().state !== 'failed'; i++)
    await delay(20);
  assert.equal(channels.status().state, 'failed');
  const conversation = await chat.create();
  assert.equal((await chat.get(conversation.id)).id, conversation.id);
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
  let chat: Awaited<ReturnType<typeof createChat>>;
  let channels: Awaited<ReturnType<typeof createChannels>>;
  t.after(async () => {
    await channels?.close();
    chat?.close();
  });
  const config = await testRuntime(t);
  chat = await createChat(config);
  channels = await createChannels(config, chat);
  assert.equal(channels.status().apiVersion, 1);
  await assert.rejects(
    channels.settings('unknown'),
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
