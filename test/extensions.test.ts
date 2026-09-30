import assert from 'node:assert/strict';
import {
  createCipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { HttpError } from '../src/auth.js';
import { createExtensions } from '../src/extensions.js';
import { mcpURL } from '../src/mcp.js';
import { createSecrets } from '../src/secrets.js';

const signal = () => AbortSignal.timeout(5000);
const secret = 'local-extension-encryption-test-secret-32-characters';
const bearer = 'local-test-bearer-not-a-real-key';
const status = (expected: number) => (error: unknown) =>
  error instanceof HttpError && error.status === expected;
const skill = {
  kind: 'skill',
  name: 'Company handbook',
  markdown: 'Be concise.',
  enabled: true,
};

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-extensions-'));
  const config = {
    baseURL: 'http://localhost:3000',
    authSecret: secret,
    databasePath: join(dir, 'rove.sqlite'),
  };
  let extensions = createExtensions(config);
  const tool = {
    name: 'lookup.order',
    description: 'Look up an order',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
      additionalProperties: false,
    },
  };
  const calls: { method: string; authorization?: string; params: unknown }[] =
    [];
  const service = {
    tools: [tool],
    reply: (_response: ServerResponse): unknown => ({
      content: [{ type: 'text', text: 'Order shipped.' }],
      structuredContent: { status: 'shipped' },
    }),
    failure: '',
  };
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({
      method: body.method,
      authorization: request.headers.authorization,
      params: body.params,
    });
    if (service.failure === 'redirect') {
      response.writeHead(307, { location: '/stolen' }).end();
      return;
    }
    if (service.failure === 'unauthorized') {
      response.writeHead(401).end(bearer);
      return;
    }
    if (body.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    let result: unknown;
    if (body.method === 'initialize') {
      response.setHeader('mcp-session-id', 'local-session');
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-server', version: '1' },
      };
    } else if (body.method === 'tools/list') {
      if (service.failure === 'sse-oversized') {
        response.setHeader('content-type', 'text/event-stream');
        response.end(`event: message\ndata: ${'x'.repeat(256_001)}`);
        return;
      }
      if (service.failure === 'oversized') {
        response.end('x'.repeat(256_001));
        return;
      }
      if (service.failure === 'malformed') {
        response.end('{invalid');
        return;
      }
      result = { tools: service.tools };
    } else if (body.method === 'tools/call') {
      result = service.reply(response);
      if (result === undefined) return;
    } else {
      response.writeHead(400).end();
      return;
    }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    if (service.failure === 'sse') {
      response.setHeader('content-type', 'text/event-stream');
      response.end(`event: message\ndata: ${reply}\n\n`);
    } else response.end(reply);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const entry = {
    kind: 'server',
    name: 'Orders',
    url: `http://127.0.0.1:${address.port}/mcp`,
    bearerToken: bearer,
    enabled: true,
  };
  t.after(async () => {
    extensions.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(dir, { force: true, recursive: true });
  });
  return {
    get extensions() {
      return extensions;
    },
    config,
    calls,
    service,
    entry,
    restart() {
      extensions.close();
      extensions = createExtensions(config);
    },
    async connect() {
      const saved = extensions.save(entry).servers[0];
      assert.ok(saved);
      await extensions.probe(saved.id, signal());
      const discovered = (await extensions.tools(signal()))[0];
      assert.ok(discovered);
      return { saved, discovered };
    },
  };
}

test('declarative skills and plugins persist, enable explicitly and reject scripts and excess instructions', async (t) => {
  const f = await fixture(t);
  const first = f.extensions.save(skill).skills[0];
  assert.ok(first);
  f.extensions.save({
    kind: 'plugin',
    name: 'Support',
    enabled: false,
    skills: [{ name: 'Tone', markdown: 'Use plain English.' }],
  });
  assert.equal(
    f.extensions.instructions(),
    '### Company handbook\nBe concise.',
  );
  const plugin = f.extensions.list().plugins[0];
  assert.ok(plugin);
  f.extensions.save({
    kind: 'plugin',
    id: plugin.id,
    name: plugin.name,
    skills: plugin.skills,
    enabled: true,
  });
  assert.match(f.extensions.instructions(), /Use plain English/);
  f.extensions.save({ ...skill, id: first.id, enabled: false });
  assert.doesNotMatch(f.extensions.instructions(), /Be concise/);
  const expected = f.extensions.list();
  f.restart();
  assert.deepEqual(f.extensions.list(), expected);
  const adopted = {
    id: randomUUID(),
    name: 'Reviewed skill',
    content: 'Follow the adopted policy.',
    enabled: true,
  };
  assert.throws(
    () => f.extensions.save({ ...skill, id: adopted.id }),
    status(404),
  );
  f.extensions.adoptSkill(adopted);
  f.extensions.adoptSkill(adopted);
  assert.equal(
    f.extensions.list().skills.filter((entry) => entry.id === adopted.id)
      .length,
    1,
  );
  assert.match(f.extensions.instructions(), /Follow the adopted policy/);
  const beforeInvalid = f.extensions.list();
  assert.throws(
    () => f.extensions.save({ ...skill, script: 'run shell' }),
    status(400),
  );
  assert.throws(
    () => f.extensions.save({ ...skill, markdown: 'x'.repeat(8001) }),
    status(400),
  );
  assert.throws(
    () =>
      f.extensions.save({
        kind: 'plugin',
        name: 'Huge',
        enabled: true,
        skills: Array.from({ length: 4 }, (_, i) => ({
          name: `Skill ${i}`,
          markdown: 'x'.repeat(8000),
        })),
      }),
    status(400),
  );
  assert.deepEqual(f.extensions.list(), beforeInvalid);
});

test('credentials remain encrypted and secret redaction survives restart and endpoint changes', async (t) => {
  const f = await fixture(t);
  const saved = f.extensions.save(f.entry).servers[0];
  assert.ok(saved);
  assert.equal(saved.configured, true);
  assert.equal(JSON.stringify(f.extensions.list()).includes(bearer), false);
  const db = new DatabaseSync(f.config.databasePath);
  try {
    const row = db
      .prepare('SELECT * FROM rove_extension WHERE id=?')
      .get(saved.id);
    assert.ok(row);
    assert.equal(JSON.stringify(row).includes(bearer), false);
    assert.equal(createSecrets(secret).decrypt(String(row.credential)), bearer);
  } finally {
    db.close();
  }
  f.restart();
  assert.throws(
    () =>
      f.extensions.save({
        ...f.entry,
        id: saved.id,
        url: `${f.entry.url}/other`,
        bearerToken: '',
      }),
    status(400),
  );
  f.extensions.save({ ...f.entry, id: saved.id, bearerToken: '' });
  assert.equal(f.extensions.list().servers[0]?.configured, true);
  f.extensions.save({
    ...f.entry,
    id: saved.id,
    bearerToken: '',
    clearToken: true,
  });
  assert.equal(f.extensions.list().servers[0]?.configured, false);
  for (const url of [
    'file:///tmp/mcp',
    'https://name:key@example.com/mcp',
    'https://example.com/mcp?key=secret',
    'https://example.com/mcp#fragment',
    'http://example.com/mcp',
  ])
    assert.throws(() => mcpURL(url, f.config.baseURL), status(400));
  assert.throws(() => mcpURL(f.entry.url, 'https://rove.example'), status(400));
  const privateServer = f.extensions.save({
    ...f.entry,
    id: saved.id,
    url: 'https://169.254.169.254/mcp',
    bearerToken: '',
  }).servers[0];
  assert.ok(privateServer);
  await assert.rejects(
    f.extensions.probe(privateServer.id, signal()),
    status(400),
  );
  assert.equal(f.calls.length, 0);
});

test('MCP discovery and execution use HTTP bearer auth, validate arguments and invalidate stale approvals', async (t) => {
  const f = await fixture(t);
  const { saved, discovered } = await f.connect();
  assert.match(discovered.name, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.deepEqual(discovered.parameters, f.service.tools[0]?.inputSchema);
  f.restart();
  assert.deepEqual(await f.extensions.tools(signal()), [discovered]);
  await assert.rejects(
    f.extensions.execute(
      discovered.name,
      { id: 123 },
      discovered.revision,
      signal(),
    ),
    status(400),
  );
  assert.equal(
    f.calls.filter((call) => call.method === 'tools/call').length,
    0,
  );
  assert.equal(
    await f.extensions.execute(
      discovered.name,
      { id: 'A-1' },
      discovered.revision,
      signal(),
    ),
    'Order shipped.\n{"status":"shipped"}',
  );
  assert.ok(f.calls.every((call) => call.authorization === `Bearer ${bearer}`));
  assert.deepEqual(
    f.calls.find((call) => call.method === 'tools/call')?.params,
    { name: 'lookup.order', arguments: { id: 'A-1' } },
  );
  f.extensions.save(skill);
  await assert.rejects(
    f.extensions.execute(
      discovered.name,
      { id: 'A-1' },
      discovered.revision,
      signal(),
    ),
    status(409),
  );
  const updated = (await f.extensions.tools(signal()))[0];
  assert.ok(updated);
  const remote = f.service.tools[0];
  assert.ok(remote);
  remote.description = 'A changed remote operation';
  await assert.rejects(
    f.extensions.execute(
      updated.name,
      { id: 'A-1' },
      updated.revision,
      signal(),
    ),
    status(409),
  );
  assert.equal(
    f.calls.filter((call) => call.method === 'tools/call').length,
    1,
  );
  f.extensions.save({
    ...f.entry,
    id: saved.id,
    bearerToken: '',
    enabled: false,
  });
  assert.deepEqual(await f.extensions.tools(signal()), []);
  await assert.rejects(
    f.extensions.execute(
      updated.name,
      { id: 'A-1' },
      updated.revision,
      signal(),
    ),
    status(409),
  );
});

test('MCP redirects, invalid catalogs and oversized responses fail without exposing provider errors', async (t) => {
  const f = await fixture(t);
  const saved = f.extensions.save(f.entry).servers[0];
  assert.ok(saved);
  for (const failure of [
    'redirect',
    'unauthorized',
    'oversized',
    'sse-oversized',
    'malformed',
  ]) {
    f.service.failure = failure;
    await assert.rejects(
      f.extensions.probe(saved.id, signal()),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 502);
        assert.equal(error.message.includes(bearer), false);
        return true;
      },
    );
    assert.deepEqual(await f.extensions.tools(signal()), []);
  }
  f.service.failure = '';
  const first = f.service.tools[0];
  assert.ok(first);
  const unsafePattern = { type: 'string', pattern: '(a+)+$' };
  first.inputSchema.properties.id = unsafePattern;
  await assert.rejects(f.extensions.probe(saved.id, signal()), status(502));
  first.inputSchema.properties.id = { type: 'string' };
  f.service.tools.push({ ...first });
  await assert.rejects(f.extensions.probe(saved.id, signal()), status(502));
});

test('MCP accepts Streamable HTTP SSE replies and validates structured tool output', async (t) => {
  const f = await fixture(t);
  f.service.failure = 'sse';
  const { discovered } = await f.connect();
  assert.match(
    await f.extensions.execute(
      discovered.name,
      { id: 'A-1' },
      discovered.revision,
      signal(),
    ),
    /Order shipped/,
  );
  f.service.reply = () => ({
    content: [{ type: 'text', text: 'Malformed structured result.' }],
    structuredContent: { status: 123 },
  });
  await assert.rejects(
    f.extensions.execute(
      discovered.name,
      { id: 'A-2' },
      discovered.revision,
      signal(),
    ),
    status(502),
  );
});

test('MCP output bounds and cancellation retain uncertain outcomes and stop the HTTP connection', async (t) => {
  const f = await fixture(t);
  const { discovered } = await f.connect();
  f.service.reply = () => ({
    content: [{ type: 'text', text: '界'.repeat(6000) }],
    structuredContent: { status: 'shipped' },
  });
  await assert.rejects(
    f.extensions.execute(
      discovered.name,
      { id: 'A-1' },
      discovered.revision,
      signal(),
    ),
    status(502),
  );
  const controller = new AbortController();
  let notify!: () => void;
  const reached = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let close!: () => void;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  f.service.reply = (response) => {
    response.once('close', close);
    notify();
    return undefined;
  };
  const pending = f.extensions.execute(
    discovered.name,
    { id: 'A-2' },
    discovered.revision,
    controller.signal,
  );
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error('Tool did not reach the server.');
      }),
    ]);
    controller.abort();
    await assert.rejects(pending, status(503));
    await closed;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await pending.catch(() => {});
  }
});

test('shared encryption opens the previous model format and rejects tampering or a changed deployment secret', () => {
  const previousKey = createHash('sha256')
    .update('rove:model-key:v1:')
    .update(secret)
    .digest();
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', previousKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(bearer, 'utf8'),
    cipher.final(),
  ]);
  const previous = Buffer.concat([
    nonce,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64');
  assert.equal(createSecrets(secret).decrypt(previous), bearer);
  assert.throws(
    () => createSecrets(`${secret}-changed`).decrypt(previous),
    status(503),
  );
  assert.throws(() => createSecrets(secret).decrypt('corrupted'), status(503));
  const secrets = createSecrets(secret);
  assert.notEqual(secrets.encrypt(bearer), secrets.encrypt(bearer));
});
