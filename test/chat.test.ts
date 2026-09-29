import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { createApplication } from '../src/app.js';

const origin = 'https://rove.example';
const apiKey = 'local-test-provider-key-never-a-real-credential';
const account = {
  name: 'Chat admin',
  email: 'admin@example.com',
  password: 'a-long-test-password',
  setupSecret: 'test-setup-secret-for-local-tests-only-32-chars',
};

function request(path: string, body?: unknown, cookie = '') {
  return new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-chat-'));
  const config = {
    baseURL: origin,
    authSecret: 'test-auth-secret-for-local-tests-only-32-chars',
    setupSecret: account.setupSecret,
    databasePath: join(dir, 'rove.sqlite'),
  };
  let app = await createApplication(config);
  const calls: {
    method?: string;
    url?: string;
    authorization?: string;
    contentType?: string;
    body: unknown;
  }[] = [];
  const provider = {
    respond: (response: ServerResponse): void | Promise<void> => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'A local provider answer.' } }],
        }),
      );
    },
  };
  const server = createServer(async (incoming, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      calls.push({
        method: incoming.method,
        url: incoming.url,
        authorization: incoming.headers.authorization,
        contentType: incoming.headers['content-type'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      });
      await provider.respond(response);
    } catch {
      response.writeHead(500).end();
    }
  });
  t.after(async () => {
    app.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const settings = {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: 'local-model',
    systemPrompt: 'Answer using the company handbook.',
    apiKey,
  };
  assert.equal((await app.fetch(request('/api/setup', account))).status, 201);
  const login = await app.fetch(request('/api/auth/sign-in/email', account));
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const fetch = (path: string, body?: unknown) =>
    app.fetch(request(path, body, cookie));
  return {
    fetch,
    cancelPending: () => app.cancelPending(),
    raw: (input: Request) => app.fetch(input),
    cookie,
    config,
    settings,
    calls,
    provider,
    async restart() {
      app.close();
      app = await createApplication(config);
    },
    async conversation() {
      const response = await fetch('/api/admin/conversations', {});
      assert.equal(response.status, 201);
      const conversation = await response.json();
      return `/api/admin/conversations/${conversation.id}`;
    },
  };
}

test('chat routes require an administrator and same-origin writes; settings protect the key', async (t) => {
  const f = await fixture(t);
  const conversation = await f.conversation();
  for (const [path, body] of [
    ['/api/admin/settings', undefined],
    ['/api/admin/settings', f.settings],
    ['/api/admin/settings/disconnect', {}],
    ['/api/admin/conversations', undefined],
    ['/api/admin/conversations', {}],
    [conversation, undefined],
    [`${conversation}/messages`, { content: 'Hello', requestId: randomUUID() }],
  ] as const) {
    assert.equal((await f.raw(request(path, body))).status, 401, path);
    if (body !== undefined) {
      const crossOrigin = request(path, body, f.cookie);
      crossOrigin.headers.set('origin', 'https://attacker.example');
      assert.equal((await f.raw(crossOrigin)).status, 403, path);
      crossOrigin.headers.delete('origin');
      assert.equal((await f.raw(crossOrigin)).status, 403, path);
    }
  }
  assert.equal(
    (await f.fetch('/api/admin/settings', { ...f.settings, apiKey: '' }))
      .status,
    400,
  );
  const saved = await f.fetch('/api/admin/settings', f.settings);
  assert.equal(saved.status, 200);
  const expected = {
    baseURL: f.settings.baseURL,
    model: f.settings.model,
    systemPrompt: f.settings.systemPrompt,
    configured: true,
  };
  assert.deepEqual(await saved.json(), expected);
  assert.deepEqual(
    await (await f.fetch('/api/admin/settings')).json(),
    expected,
  );
  const db = new DatabaseSync(f.config.databasePath);
  try {
    const row = db.prepare('SELECT * FROM rove_model').get();
    assert.ok(row?.api_key);
    assert.notEqual(row.api_key, apiKey);
    assert.equal(JSON.stringify(row).includes(apiKey), false);
  } finally {
    db.close();
  }
  assert.equal(
    (
      await f.fetch('/api/admin/settings', {
        ...f.settings,
        baseURL: `${f.settings.baseURL}/another-provider`,
        apiKey: '',
      })
    ).status,
    400,
  );
  for (const baseURL of [
    'invalid',
    'http://provider.example/v1',
    'ftp://127.0.0.1/v1',
    'https://name:password@provider.example/v1',
    'https://provider.example/v1?key=secret',
    'https://provider.example/v1#fragment',
  ]) {
    assert.equal(
      (await f.fetch('/api/admin/settings', { ...f.settings, baseURL })).status,
      400,
      baseURL,
    );
  }
  assert.deepEqual(
    await (await f.fetch('/api/admin/settings')).json(),
    expected,
  );
  for (const message of [
    { content: '', requestId: randomUUID() },
    { content: '   ', requestId: randomUUID() },
    { content: 'x'.repeat(4001), requestId: randomUUID() },
    { content: 'Hello', requestId: 'not-a-uuid' },
    { content: 'Hello' },
  ]) {
    assert.equal(
      (await f.fetch(`${conversation}/messages`, message)).status,
      400,
    );
  }
  assert.equal(f.calls.length, 0);
});

test('maximum-length Unicode and JSON-escaped messages reach the provider intact', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  for (const content of ['界'.repeat(4000), '\u0001'.repeat(4000)]) {
    const conversation = await f.conversation();
    const response = await f.fetch(`${conversation}/messages`, {
      content,
      requestId: randomUUID(),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages, [
      { role: 'user', content },
      { role: 'assistant', content: 'A local provider answer.' },
    ]);
    assert.deepEqual(f.calls.at(-1)?.body, {
      model: f.settings.model,
      messages: [
        { role: 'system', content: f.settings.systemPrompt },
        { role: 'user', content },
      ],
      stream: false,
      max_completion_tokens: 2048,
    });
  }
  assert.equal(f.calls.length, 2);
});

test('real Chat Completions requests preserve history, retries and settings across restart', async (t) => {
  const f = await fixture(t);
  const conversation = await f.conversation();
  const message = {
    content: 'What is our leave policy?',
    requestId: randomUUID(),
  };
  assert.equal(
    (await f.fetch(`${conversation}/messages`, message)).status,
    409,
  );
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const first = await f.fetch(`${conversation}/messages`, message);
  assert.equal(first.status, 200);
  const firstConversation = await first.json();
  assert.equal(firstConversation.title, message.content);
  assert.deepEqual(firstConversation.messages, [
    { role: 'user', content: message.content },
    { role: 'assistant', content: 'A local provider answer.' },
  ]);
  assert.deepEqual(f.calls[0], {
    method: 'POST',
    url: '/v1/chat/completions',
    authorization: `Bearer ${apiKey}`,
    contentType: 'application/json',
    body: {
      model: 'local-model',
      messages: [
        { role: 'system', content: f.settings.systemPrompt },
        { role: 'user', content: message.content },
      ],
      stream: false,
      max_completion_tokens: 2048,
    },
  });
  assert.deepEqual(
    await (await f.fetch(`${conversation}/messages`, message)).json(),
    firstConversation,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (
      await f.fetch(`${conversation}/messages`, {
        ...message,
        content: 'A different message',
      })
    ).status,
    409,
  );
  const other = await f.conversation();
  assert.equal((await f.fetch(`${other}/messages`, message)).status, 409);
  await f.restart();
  assert.deepEqual(
    await (await f.fetch(conversation)).json(),
    firstConversation,
  );
  assert.deepEqual(
    await (await f.fetch(`${conversation}/messages`, message)).json(),
    firstConversation,
  );
  assert.equal(f.calls.length, 1);
  const changed = await f.fetch('/api/admin/settings', {
    ...f.settings,
    model: 'updated-local-model',
    apiKey: '',
  });
  assert.equal(changed.status, 200);
  const second = await f.fetch(`${conversation}/messages`, {
    content: 'And who approves it?',
    requestId: randomUUID(),
  });
  assert.equal(second.status, 200);
  const secondConversation = await second.json();
  assert.equal(secondConversation.messages.length, 4);
  assert.equal(secondConversation.title, message.content);
  assert.deepEqual(f.calls[1]?.body, {
    model: 'updated-local-model',
    messages: [
      { role: 'system', content: f.settings.systemPrompt },
      ...firstConversation.messages,
      { role: 'user', content: 'And who approves it?' },
    ],
    stream: false,
    max_completion_tokens: 2048,
  });
  assert.equal(f.calls[1]?.authorization, `Bearer ${apiKey}`);
  const listing = await (await f.fetch('/api/admin/conversations')).json();
  assert.ok(
    listing.conversations.some(
      (entry: { id: string }) => entry.id === firstConversation.id,
    ),
  );
  const disconnected = await f.fetch('/api/admin/settings/disconnect', {});
  assert.equal(disconnected.status, 200);
  assert.equal((await disconnected.json()).configured, false);
  await f.restart();
  assert.equal(
    (await (await f.fetch('/api/admin/settings')).json()).configured,
    false,
  );
  assert.deepEqual(
    await (await f.fetch(conversation)).json(),
    secondConversation,
  );
  assert.equal(
    (
      await f.fetch(`${conversation}/messages`, {
        content: 'New question',
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(f.calls.length, 2);
});

test('provider errors leave no half-exchange and the same request can safely retry', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const conversation = await f.conversation();
  const empty = await (await f.fetch(conversation)).json();
  const answer = f.provider.respond;
  const failures = [
    { status: 401, body: 'private-provider-error', expected: 502 },
    { status: 429, body: 'private-provider-error', expected: 503 },
    { status: 500, body: 'private-provider-error', expected: 502 },
    { status: 200, body: '{invalid json', expected: 502 },
    { status: 200, body: JSON.stringify({ choices: [] }), expected: 502 },
    {
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: '  ' } }] }),
      expected: 502,
    },
    {
      status: 200,
      body: JSON.stringify({
        choices: [
          { message: { content: 'unfinished' }, finish_reason: 'length' },
        ],
      }),
      expected: 502,
    },
    { status: 200, body: 'x'.repeat(256_001), expected: 502 },
    { status: 307, body: 'redirect', expected: 502 },
  ];
  for (const failure of failures) {
    f.provider.respond = (response) => {
      response.writeHead(failure.status, {
        'content-type': 'application/json',
        location: `${f.settings.baseURL}/must-not-receive-key`,
      });
      response.end(failure.body);
    };
    const before = f.calls.length;
    const message = {
      content: 'Do not save an unanswered question',
      requestId: randomUUID(),
    };
    const response = await f.fetch(`${conversation}/messages`, message);
    assert.equal(response.status, failure.expected);
    assert.equal(
      (await response.text()).includes('private-provider-error'),
      false,
    );
    assert.equal(f.calls.length, before + 1, 'redirects must not be followed');
    assert.deepEqual(await (await f.fetch(conversation)).json(), empty);
  }
  const retry = {
    content: 'Retry this exact request',
    requestId: randomUUID(),
  };
  assert.equal((await f.fetch(`${conversation}/messages`, retry)).status, 502);
  f.provider.respond = answer;
  assert.equal((await f.fetch(`${conversation}/messages`, retry)).status, 200);
  const saved = await (await f.fetch(conversation)).json();
  assert.deepEqual(saved.messages, [
    { role: 'user', content: retry.content },
    { role: 'assistant', content: 'A local provider answer.' },
  ]);
  const before = f.calls.length;
  assert.equal((await f.fetch(`${conversation}/messages`, retry)).status, 200);
  assert.equal(f.calls.length, before);
});

test('an in-flight reply rejects competing messages and settings changes until completion', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const conversation = await f.conversation();
  const other = await f.conversation();
  const answer = f.provider.respond;
  let announce!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.provider.respond = async (response) => {
    announce();
    await held;
    await answer(response);
  };
  const message = { content: 'A slow question', requestId: randomUUID() };
  const pending = f.fetch(`${conversation}/messages`, message);
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('The request ended before reaching the provider.');
      }),
    ]);
    for (const path of [`${conversation}/messages`, `${other}/messages`]) {
      assert.equal((await f.fetch(path, message)).status, 409);
    }
    assert.equal(
      (await f.fetch('/api/admin/settings', f.settings)).status,
      409,
    );
    assert.equal(
      (await f.fetch('/api/admin/settings/disconnect', {})).status,
      409,
    );
    assert.deepEqual((await (await f.fetch(conversation)).json()).messages, []);
    assert.equal(f.calls.length, 1);
  } finally {
    release();
    assert.equal((await pending).status, 200);
  }
  assert.equal(
    (await f.fetch(`${conversation}/messages`, message)).status,
    200,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.fetch('/api/admin/settings/disconnect', {})).status,
    200,
  );
});

test('shutdown cancels the provider request and requires restart before retry', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const conversation = await f.conversation();
  const empty = await (await f.fetch(conversation)).json();
  const answer = f.provider.respond;
  let announce!: () => void;
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  let closed!: () => void;
  const providerClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  let disconnect = () => {};
  f.provider.respond = async (response) => {
    disconnect = () => {
      response.destroy();
    };
    response.once('close', closed);
    announce();
    await providerClosed;
  };
  const message = {
    content: 'Retry after restarting',
    requestId: randomUUID(),
  };
  const pending = f.fetch(`${conversation}/messages`, message);
  // Bound a broken cancellation implementation without waiting for the provider timeout.
  const timeout = setTimeout(() => disconnect(), 2000);
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('The request did not reach the provider.');
      }),
    ]);
    f.cancelPending();
    const cancelled = await pending;
    assert.equal(cancelled.status, 503);
    assert.match((await cancelled.json()).message, /retry/i);
    await providerClosed;
    assert.deepEqual(await (await f.fetch(conversation)).json(), empty);
    f.provider.respond = answer;
    assert.equal(
      (await f.fetch(`${conversation}/messages`, message)).status,
      503,
    );
    assert.equal(f.calls.length, 1);
    await f.restart();
    assert.equal(
      (await f.fetch(`${conversation}/messages`, message)).status,
      200,
    );
    assert.equal(f.calls.length, 2);
    assert.deepEqual((await (await f.fetch(conversation)).json()).messages, [
      { role: 'user', content: message.content },
      { role: 'assistant', content: 'A local provider answer.' },
    ]);
  } finally {
    clearTimeout(timeout);
    disconnect();
    await pending;
  }
});

test('shutdown before the first message blocks provider admission until restart', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const conversation = await f.conversation();
  const message = {
    content: 'Arrived during shutdown',
    requestId: randomUUID(),
  };
  f.cancelPending();
  assert.equal(
    (await f.fetch(`${conversation}/messages`, message)).status,
    503,
  );
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await (await f.fetch(conversation)).json()).messages, []);
  await f.restart();
  assert.equal(
    (await f.fetch(`${conversation}/messages`, message)).status,
    200,
  );
  assert.equal(f.calls.length, 1);
});

test('a corrupt saved key fails safely and replacing the key restores the same request', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  const conversation = await f.conversation();
  const db = new DatabaseSync(f.config.databasePath);
  try {
    db.prepare('UPDATE rove_model SET api_key = ?').run('corrupted-ciphertext');
  } finally {
    db.close();
  }
  const message = {
    content: 'A question after restoring the key',
    requestId: randomUUID(),
  };
  const rejected = await f.fetch(`${conversation}/messages`, message);
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).message, /save a new key/i);
  assert.deepEqual((await (await f.fetch(conversation)).json()).messages, []);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.fetch('/api/admin/settings', f.settings)).status, 200);
  assert.equal(
    (await f.fetch(`${conversation}/messages`, message)).status,
    200,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.authorization, `Bearer ${apiKey}`);
});
