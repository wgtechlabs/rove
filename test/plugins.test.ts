import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { createChat } from '../src/chat.js';
import { createExtensions } from '../src/extensions.js';
import { createPluginChannels } from '../src/plugin-channel.js';
import { compatibility, parsePackage } from '../src/plugin-manifest.js';
import { createPlugins } from '../src/plugins.js';

const repo = 'example/company-agent';
const manifest = (version = '1.0.0') => ({
  schemaVersion: 1,
  apiVersion: 1,
  id: 'company-agent',
  name: 'Company agent',
  version,
  category: 'agent',
  description: 'Company instructions',
  skills: [
    { name: 'Policy', markdown: `Policy ${version}. \${settings.tone}` },
  ],
  settings: [{ key: 'tone', label: 'Tone', type: 'text', required: true }],
});
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-plugins-'));
  const config = {
    baseURL: 'http://localhost:3000',
    authSecret: 'plugin-test-secret-not-a-real-credential-123',
    databasePath: join(dir, 'rove.sqlite'),
  };
  let extensions = createExtensions(config);
  const state = {
    bytes: JSON.stringify(manifest()),
    onFetch: () => {},
    calls: 0,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    state.calls++;
    state.onFetch();
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer dummy-github-token',
    );
    const url = new URL(String(input));
    if (url.pathname.includes('/releases/tags/'))
      return Response.json({
        tag_name: url.pathname.split('/').at(-1),
        draft: false,
        prerelease: false,
        assets: [
          {
            id: 7,
            name: 'rove-plugin.json',
            state: 'uploaded',
            size: Buffer.byteLength(state.bytes),
            digest: `sha256:${hash(state.bytes)}`,
          },
        ],
      });
    if (url.pathname.includes('/git/ref/tags/'))
      return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (url.pathname.endsWith('/contents/rove-plugin.json'))
      return Response.json({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(state.bytes).toString('base64'),
      });
    if (url.pathname.endsWith('/releases/assets/7'))
      return new Response(state.bytes);
    assert.fail(`Unexpected request ${url}`);
  };
  const env = { ROVE_PLUGIN_SECRET_ORDERS: 'environment-mcp-secret' };
  let plugins = createPlugins(config, extensions, fetchImpl, env);
  t.after(() => {
    plugins.close();
    extensions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    config,
    state,
    env,
    get plugins() {
      return plugins;
    },
    get extensions() {
      return extensions;
    },
    approve() {
      plugins.saveSource({ repo, approved: true, token: 'dummy-github-token' });
    },
    async install(pkg: unknown = manifest()) {
      state.bytes = JSON.stringify(pkg);
      await plugins.install({
        repo,
        tag: `v${(pkg as { version: string }).version}`,
      });
      return current();
    },
    restart() {
      plugins.close();
      extensions.close();
      extensions = createExtensions(config);
      plugins = createPlugins(config, extensions, fetchImpl, env);
    },
    current,
    configure(grants: string[] = [], bindings: Record<string, unknown> = {}) {
      const item = current();
      plugins.configure({
        id: item.id,
        revision: item.revision,
        digest: item.versions[0]?.digest,
        values: { tone: 'Be concise.' },
        secrets: bindings,
        grants,
      });
      return current();
    },
    activate(digest?: string) {
      const item = current();
      return plugins.activate({
        id: item.id,
        revision: item.revision,
        digest: digest ?? item.versions[0]?.digest,
      });
    },
  };
  function current() {
    const item = plugins.list().installations[0];
    assert.ok(item);
    return item;
  }
}

test('manifest contracts reject undeclared executable authority and duplicate contributions', () => {
  const pkg = parsePackage(manifest());
  assert.equal(compatibility(pkg), null);
  for (const change of [
    { apiVersion: 2 },
    { entrypoint: 'run.js' },
    { hooks: {} },
    { capabilities: ['network:*'] },
    {
      skills: [
        { name: 'a', markdown: 'x' },
        { name: 'a', markdown: 'y' },
      ],
    },
    {
      settings: [
        { key: 'tone', label: 'Tone', type: 'boolean', default: 'wrong' },
      ],
    },
    { skills: [{ name: 'a', markdown: `\${settings.unknown}` }] },
  ])
    assert.throws(() => parsePackage({ ...manifest(), ...change }));
  assert.equal(
    compatibility(parsePackage({ ...manifest(), category: 'user' })),
    null,
  );
  assert.equal(
    compatibility(
      parsePackage({
        ...manifest(),
        pages: [
          { id: 'policy', title: 'Policy', content: 'Reviewed guidance' },
        ],
      }),
    ),
    null,
  );
  const executable = {
    ...manifest(),
    category: 'user',
    execution: {
      runtime: 'node',
      source: 'export const run = async () => "done";',
    },
    capabilities: ['execute:offline'],
    operations: [
      {
        id: 'summarize',
        name: 'Summarize',
        description: 'Summarize supplied data.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        surfaces: ['tool', 'action'],
      },
    ],
  };
  assert.match(compatibility(parsePackage(executable)) ?? '', /unavailable/);
  for (const change of [
    { category: 'agent' },
    { capabilities: [] },
    { execution: undefined },
    { execution: { runtime: 'node', source: 'é'.repeat(16001) } },
    { operations: [] },
    { operations: [{ ...executable.operations[0], id: 'a'.repeat(65) }] },
    {
      operations: [
        {
          ...executable.operations[0],
          inputSchema: {
            type: 'object',
            $ref: 'https://external.example/schema',
          },
        },
      ],
    },
    {
      operations: [
        { ...executable.operations[0], surfaces: ['action', 'action'] },
      ],
    },
    {
      pages: [{ id: 'home', title: 'Home', content: '', actions: ['unknown'] }],
    },
  ])
    assert.throws(() => parsePackage({ ...executable, ...change }));
});

test('approved releases install inactive, atomically activate, update and roll back across two restarts', async (t) => {
  const f = fixture(t);
  const local = f.extensions.save({
    kind: 'skill',
    name: 'Local knowledge',
    markdown: 'Preserve this.',
    enabled: true,
  }).skills[0];
  assert.ok(local);
  await assert.rejects(f.install(), /Approve/);
  assert.equal(f.state.calls, 0);
  f.approve();
  let item = await f.install();
  assert.equal(item.active, null);
  assert.doesNotMatch(f.extensions.instructions(), /Policy/);
  await assert.rejects(f.activate(), /required setting/);
  item = f.configure();
  const oldDigest = item.versions[0]?.digest;
  assert.ok(oldDigest);
  await f.activate();
  assert.match(f.extensions.instructions(), /Policy 1.0.0. Be concise/);
  const owned = f.extensions.list().skills.find((entry) => entry.managedBy);
  assert.ok(owned);
  assert.throws(
    () =>
      f.extensions.save({
        ...owned,
        kind: 'skill',
        markdown: 'Bypass immutable content.',
      }),
    /valid skill|Manage released/,
  );
  // The trusted local adoption helper cannot overwrite an immutable package either.
  assert.throws(
    () =>
      f.extensions.adoptSkill({
        id: owned.id,
        name: 'Bypass',
        content: 'wrong',
        enabled: true,
      }),
    /Manage released/,
  );
  await f.install(manifest('2.0.0'));
  assert.equal(f.current().active, oldDigest);
  await f.activate();
  assert.match(f.extensions.instructions(), /Policy 2.0.0/);
  await assert.rejects(
    f.install({ ...manifest('2.0.0'), description: 'Tampered release' }),
    /different bytes/,
  );
  const before = f.current().active;
  await f.install({ ...manifest('3.0.0'), category: 'user', skills: [] });
  await assert.rejects(f.activate(), /no supported contributions/);
  assert.equal(f.current().active, before);
  await assert.rejects(
    f.plugins.install({ repo, tag: 'republished' }),
    /different release identity/,
  );
  f.restart();
  f.restart();
  assert.equal(f.current().active, before);
  await f.activate(oldDigest);
  assert.match(f.extensions.instructions(), /Policy 1.0.0/);
  assert.equal(
    f.extensions.list().skills.find((entry) => entry.name === 'Local knowledge')
      ?.id,
    local.id,
  );
  assert.equal(
    f.extensions.list().skills.find((entry) => entry.managedBy)?.id,
    owned.id,
  );
  assert.ok(f.current().audit.some((entry) => entry.event === 'activated'));
  assert.doesNotMatch(JSON.stringify(f.plugins.list()), /dummy-github-token/);
});

test('release lists use bounded summaries while selected details verify ownership and immutable bytes', async (t) => {
  const f = fixture(t);
  f.approve();
  await f.install();
  const db = new DatabaseSync(f.config.databasePath);
  t.after(() => db.close());
  // Exercise the pre-summary schema and the maximum retained inventory on restart.
  db.exec(
    'DELETE FROM rove_plugin_artifact; ALTER TABLE rove_plugin_artifact DROP COLUMN summary; DELETE FROM rove_plugin_installation;',
  );
  let fullManifestBytes = 0;
  for (let index = 0; index < 16; index++) {
    const id = randomUUID();
    const pluginId = `company-${index}`;
    db.prepare('INSERT INTO rove_plugin_installation VALUES(?,?,?,?)').run(
      id,
      repo,
      pluginId,
      JSON.stringify({
        id,
        repo,
        pluginId,
        active: null,
        revision: randomUUID(),
        values: {},
        secrets: {},
        grants: [],
      }),
    );
    for (let version = 0; version < 16; version++) {
      const pkg = parsePackage({
        ...manifest(`1.0.${version}`),
        id: pluginId,
        skills: Array.from({ length: 3 }, (_, skill) => ({
          name: `Knowledge ${skill}`,
          markdown: '界'.repeat(8000),
        })),
        instructions: '',
        pages: Array.from({ length: 4 }, (_, page) => ({
          id: `page-${page}`,
          title: `Page ${page}`,
          content: 'z'.repeat(8000),
        })),
      });
      const bytes = JSON.stringify(pkg);
      const digest = hash(bytes);
      fullManifestBytes += Buffer.byteLength(bytes);
      db.prepare('INSERT INTO rove_plugin_artifact VALUES(?,?,?,?,?)').run(
        digest,
        repo,
        pluginId,
        pkg.version,
        JSON.stringify({
          repo,
          digest,
          bytes,
          manifest: pkg,
          tag: `v${pkg.version}`,
          commit: 'a'.repeat(40),
          assetId: 7,
        }),
      );
    }
  }
  f.restart();
  const list = f.plugins.list();
  assert.equal(list.installations.length, 16);
  assert.ok(list.installations.every((item) => item.versions.length === 16));
  const responseBytes = Buffer.byteLength(JSON.stringify(list));
  assert.ok(fullManifestBytes > 26_000_000);
  assert.ok(
    responseBytes < 100_000,
    `summary response was ${responseBytes} bytes`,
  );
  const item = list.installations[0];
  const other = list.installations[1];
  assert.ok(item && other && item.versions[0]);
  const summary = item.versions[0];
  assert.equal('manifest' in summary, false);
  const detail = f.plugins.detail(item.id, summary.digest);
  assert.equal(detail.manifest.pages.length, 4);
  assert.equal(detail.manifest.version, summary.version);
  assert.throws(
    () => f.plugins.detail(other.id, summary.digest),
    /another installation/,
  );
  const corrupted = JSON.parse(
    String(
      db
        .prepare('SELECT data FROM rove_plugin_artifact WHERE digest=?')
        .get(summary.digest)?.data,
    ),
  );
  corrupted.bytes = '{}';
  db.prepare('UPDATE rove_plugin_artifact SET data=? WHERE digest=?').run(
    JSON.stringify(corrupted),
    summary.digest,
  );
  assert.deepEqual(
    f.plugins.list(),
    list,
    'list should not inspect unselected artifact bodies',
  );
  assert.throws(
    () => f.plugins.detail(item.id, summary.digest),
    /integrity check/,
  );
  await assert.rejects(
    f.plugins.activate({
      id: item.id,
      revision: item.revision,
      digest: summary.digest,
    }),
    /integrity check/,
  );
  t.diagnostic(
    `256 full manifests: ${fullManifestBytes} bytes; summary response: ${responseBytes} bytes`,
  );
});

test('revocation during preparation, stale settings, and immutable source identity fail closed', async (t) => {
  const f = fixture(t);
  f.approve();
  await f.install();
  f.configure();
  await f.activate();
  const old = f.current();
  f.plugins.configure({
    id: old.id,
    revision: old.revision,
    digest: old.active,
    values: { tone: 'New tone' },
    grants: [],
  });
  assert.equal(f.current().active, null);
  assert.doesNotMatch(f.extensions.instructions(), /Policy/);
  await assert.rejects(
    f.plugins.activate({
      id: old.id,
      revision: old.revision,
      digest: old.active,
    }),
    /changed/,
  );
  await f.activate();
  f.state.onFetch = () => {
    f.state.onFetch = () => {};
    f.plugins.saveSource({ repo, approved: false });
  };
  await assert.rejects(f.install(manifest('2.0.0')), /approval changed/);
  assert.equal(f.current().active, null);
  assert.doesNotMatch(f.extensions.instructions(), /Policy/);
  assert.equal(f.current().versions.length, 1);
  await assert.rejects(f.activate(), /Approve/);
  f.plugins.saveSource({
    repo: 'other/company-agent',
    approved: true,
    token: 'dummy-github-token',
  });
  f.state.bytes = JSON.stringify(manifest());
  await assert.rejects(
    f.plugins.install({ repo: 'other/company-agent', tag: 'v1.0.0' }),
    /another source/,
  );
});

test('generic installation cannot bypass a matching AIP review and release gate', async (t) => {
  const f = fixture(t);
  f.approve();
  await f.install();
  f.configure();
  const db = new DatabaseSync(f.config.databasePath);
  t.after(() => db.close());
  db.exec(
    'CREATE TABLE rove_aip(id TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL)',
  );
  const record = {
    id: randomUUID(),
    repo,
    skillName: 'company-agent',
    packageVersion: '1.0.0',
    status: 'published',
  };
  db.prepare('INSERT INTO rove_aip VALUES(?,?,?)').run(
    record.id,
    'web:test',
    JSON.stringify(record),
  );
  await assert.rejects(f.activate(), /belongs to an AIP/);
  assert.equal(f.current().active, null);
  assert.doesNotMatch(f.extensions.instructions(), /Policy/);
  // Previously activated, exactly pinned releases can be restored through rollback.
  const digest = f.current().versions[0]?.digest;
  assert.ok(digest);
  const release = JSON.parse(
    String(
      db
        .prepare('SELECT data FROM rove_plugin_artifact WHERE digest=?')
        .get(digest)?.data,
    ),
  );
  const reviewed = {
    ...record,
    status: 'activating',
    candidateHead: 'b'.repeat(40),
    review: { headSha: 'b'.repeat(40) },
    release: { digest, commit: 'a'.repeat(40), assetId: 7 },
  };
  db.prepare('UPDATE rove_aip SET data=? WHERE id=?').run(
    JSON.stringify(reviewed),
    record.id,
  );
  const competing = { ...record, id: randomUUID() };
  db.prepare('INSERT INTO rove_aip VALUES(?,?,?)').run(
    competing.id,
    'web:another-conversation',
    JSON.stringify(competing),
  );
  await f.plugins.activateRelease({
    id: record.id,
    name: record.skillName,
    content: 'reviewed',
    enabled: true,
    release,
  });
  assert.equal(f.current().active, digest);
  f.plugins.deactivate({ id: f.current().id, revision: f.current().revision });
  db.prepare('UPDATE rove_aip SET data=? WHERE id=?').run(
    JSON.stringify({
      ...record,
      status: 'activated',
      release: { digest, commit: 'a'.repeat(40), assetId: 7 },
    }),
    record.id,
  );
  await f.activate();
  assert.match(f.extensions.instructions(), /Policy/);
});

test('existing IDs, encrypted credentials, histories and uncertain runs survive additive migration', async (t) => {
  const f = fixture(t);
  const server = f.extensions.save({
    kind: 'server',
    name: 'Legacy MCP',
    url: 'https://tools.example.com/mcp',
    bearerToken: 'legacy-dummy-key',
    enabled: false,
  }).servers[0];
  assert.ok(server);
  const db = new DatabaseSync(f.config.databasePath);
  db.exec(
    'CREATE TABLE rove_run(id TEXT PRIMARY KEY, conversation TEXT, scope TEXT, data TEXT); CREATE TABLE rove_slack_fixture(id TEXT PRIMARY KEY, data TEXT);',
  );
  const runId = randomUUID();
  const data = JSON.stringify({
    status: 'executing',
    scope: 'slack:T:C:thread',
  });
  db.prepare('INSERT INTO rove_run VALUES(?,?,?,?)').run(
    runId,
    'thread',
    'slack:T:C:thread',
    data,
  );
  db.prepare('INSERT INTO rove_slack_fixture VALUES(?,?)').run(
    'thread',
    'uncertain',
  );
  const credential = db
    .prepare('SELECT credential FROM rove_extension WHERE id=?')
    .get(server.id)?.credential;
  f.approve();
  await f.install();
  f.configure();
  await f.activate();
  f.restart();
  f.restart();
  assert.equal(
    db
      .prepare('SELECT credential FROM rove_extension WHERE id=?')
      .get(server.id)?.credential,
    credential,
  );
  assert.equal(f.extensions.list().servers[0]?.id, server.id);
  assert.equal(
    db.prepare('SELECT data FROM rove_run WHERE id=?').get(runId)?.data,
    data,
  );
  assert.equal(
    db.prepare('SELECT data FROM rove_slack_fixture').get()?.data,
    'uncertain',
  );
  db.close();
});

test('managed MCP uses existing approval revisions, hides secrets and revokes dispatch immediately', async (t) => {
  const f = fixture(t);
  let effects = 0;
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    observed.push(request.headers.authorization ?? '');
    if (input.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }
    if (input.method === 'tools/call') effects++;
    const result =
      input.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'orders', version: '1' },
          }
        : input.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'lookup',
                  description: 'Find order',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'Found.' }] };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const pkg = {
    ...manifest(),
    servers: [
      {
        id: 'orders',
        name: 'Orders',
        url: `http://127.0.0.1:${address.port}/mcp`,
        secret: 'api-key',
      },
    ],
    secrets: [{ key: 'api-key', label: 'API key', required: true }],
    capabilities: ['mcp:orders'],
  };
  f.approve();
  await f.install(pkg);
  f.configure();
  await assert.rejects(f.activate(), /Grant/);
  f.configure(['mcp:orders']);
  await assert.rejects(f.activate(), /required secret/);
  f.configure(['mcp:orders'], {
    'api-key': { source: 'environment', name: 'ROVE_PLUGIN_SECRET_ORDERS' },
  });
  await f.activate();
  const tool = (await f.extensions.tools(AbortSignal.timeout(5000)))[0];
  assert.ok(tool);
  assert.equal(
    await f.extensions.execute(
      tool.name,
      {},
      tool.revision,
      AbortSignal.timeout(5000),
    ),
    'Found.',
  );
  assert.equal(effects, 1);
  assert.ok(
    observed.every((value) => value === 'Bearer environment-mcp-secret'),
  );
  assert.doesNotMatch(
    JSON.stringify(f.plugins.list()),
    /environment-mcp-secret/,
  );
  f.env.ROVE_PLUGIN_SECRET_ORDERS = 'rotated-environment-secret';
  f.restart();
  assert.equal(f.current().active, null);
  assert.ok(
    f
      .current()
      .audit.some((entry) => entry.event === 'environment-secret-changed'),
  );
  await assert.rejects(
    f.extensions.execute(
      tool.name,
      {},
      tool.revision,
      AbortSignal.timeout(5000),
    ),
    /no longer enabled/,
  );
  await f.activate();
  f.configure(['mcp:orders'], {
    'api-key': { source: 'stored', value: 'stored-dummy-secret' },
  });
  await f.activate();
  await assert.rejects(
    f.extensions.execute(
      tool.name,
      {},
      tool.revision,
      AbortSignal.timeout(5000),
    ),
    /changed/,
  );
  const fresh = (await f.extensions.tools(AbortSignal.timeout(5000)))[0];
  assert.ok(fresh);
  f.plugins.saveSource({ repo, approved: false });
  await assert.rejects(
    f.extensions.execute(
      fresh.name,
      {},
      fresh.revision,
      AbortSignal.timeout(5000),
    ),
    /no longer enabled/,
  );
  assert.equal(effects, 1);
});

test('verified channel installations gate signed ingress and revoke it on configuration, source and secret changes across restart', async (t) => {
  const f = fixture(t);
  const pkg = {
    ...manifest(),
    category: 'channel',
    settings: [],
    skills: [],
    secrets: [
      { key: 'signing', label: 'Signing key', required: true },
      { key: 'delivery', label: 'Delivery key', required: true },
    ],
    capabilities: ['channel:ingress', 'channel:delivery'],
    channel: {
      type: 'hmac-json',
      signing: {
        secret: 'signing',
        timestampHeader: 'x-fixture-time',
        signatureHeader: 'x-fixture-signature',
      },
      incoming: {
        eventId: '/id',
        tenant: '/tenant',
        actor: '/actor',
        destination: '/destination',
        thread: '/thread',
        text: '/text',
      },
      outgoing: {
        url: 'https://channel.example/send',
        secret: 'delivery',
        fields: { destination: 'destination', thread: 'thread', text: 'text' },
      },
    },
  };
  const access = {
    tenant: 'company',
    users: ['alice'],
    admins: [],
    destinations: ['general'],
  };
  const configure = (
    grants: string[],
    secrets: Record<string, unknown> = {},
  ) => {
    const item = f.current();
    f.plugins.configure({
      id: item.id,
      revision: item.revision,
      digest: item.versions[0]?.digest,
      values: {},
      grants,
      secrets,
      channelAccess: access,
    });
  };
  await assert.rejects(f.install(pkg), /Approve/);
  assert.equal(f.state.calls, 0);
  f.approve();
  await f.install(pkg);
  const installation = f.current().id;
  await assert.rejects(f.activate(), /Configure the channel/);
  configure([]);
  await assert.rejects(f.activate(), /Grant/);
  configure(pkg.capabilities);
  await assert.rejects(f.activate(), /required secret/);
  configure(pkg.capabilities, {
    signing: { source: 'environment', name: 'ROVE_PLUGIN_SECRET_ORDERS' },
    delivery: { source: 'stored', value: 'fixture-delivery-secret' },
  });
  await f.activate();
  const pinnedDigest = f.current().active;
  assert.ok(pinnedDigest);
  assert.equal(f.plugins.activeChannel(installation)?.digest, pinnedDigest);
  assert.doesNotMatch(
    JSON.stringify(f.plugins.list()),
    /environment-mcp-secret|fixture-delivery-secret/,
  );
  let chat = createChat(f.config);
  let gateway = createPluginChannels(f.config, chat, (id) =>
    f.plugins.activeChannel(id),
  );
  const acceptedEvent = randomUUID();
  const request = (
    key = f.env.ROVE_PLUGIN_SECRET_ORDERS,
    id = randomUUID(),
  ) => {
    const stamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id,
      tenant: 'company',
      actor: 'alice',
      destination: 'general',
      thread: 'topic',
      text: 'Hello from an installed release.',
      role: 'admin',
      scope: 'web',
    });
    return new Request(
      `${f.config.baseURL}/api/channels/${installation}/events`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fixture-time': String(stamp),
          'x-fixture-signature': `v1=${createHmac('sha256', key).update(`v1:${stamp}:${body}`).digest('hex')}`,
        },
        body,
      },
    );
  };
  try {
    assert.equal(
      (await gateway.handle(request(undefined, acceptedEvent), installation))
        .status,
      202,
    );
    const db = new DatabaseSync(f.config.databasePath);
    try {
      const saved = db
        .prepare('SELECT scope,snapshot FROM rove_plugin_channel_job')
        .get();
      assert.ok(saved);
      assert.match(
        String(saved.scope),
        new RegExp(`^plugin-channel:${installation}:`),
      );
      assert.doesNotMatch(
        String(saved.snapshot),
        /environment-mcp-secret|fixture-delivery-secret/,
      );
    } finally {
      db.close();
    }
    assert.equal(
      chat.list().length,
      0,
      'acknowledging ingress must not execute chat synchronously',
    );
    configure(pkg.capabilities);
    assert.equal(f.plugins.activeChannel(installation), undefined);
    await assert.rejects(gateway.handle(request(), installation), /not active/);
    await f.activate();
    assert.equal((await gateway.handle(request(), installation)).status, 202);
    f.plugins.saveSource({ repo, approved: false });
    assert.equal(f.current().active, null);
    await assert.rejects(gateway.handle(request(), installation), /not active/);
    f.approve();
    await f.activate();
    const oldSigning = f.env.ROVE_PLUGIN_SECRET_ORDERS;
    f.env.ROVE_PLUGIN_SECRET_ORDERS = 'fixture-rotated-signing-secret';
    assert.equal(f.plugins.activeChannel(installation), undefined);
    await assert.rejects(gateway.handle(request(), installation), /not active/);
    await gateway.close();
    chat.close();
    f.restart();
    chat = createChat(f.config);
    gateway = createPluginChannels(f.config, chat, (id) =>
      f.plugins.activeChannel(id),
    );
    assert.equal(f.current().active, null);
    assert.ok(
      f
        .current()
        .audit.some((entry) => entry.event === 'environment-secret-changed'),
    );
    await assert.rejects(gateway.handle(request(), installation), /not active/);
    await f.activate();
    assert.equal(f.plugins.activeChannel(installation)?.digest, pinnedDigest);
    await assert.rejects(
      gateway.handle(request(oldSigning), installation),
      /Invalid channel signature/,
    );
    assert.equal((await gateway.handle(request(), installation)).status, 202);
    assert.equal(
      (await gateway.handle(request(undefined, acceptedEvent), installation))
        .status,
      200,
      'accepted event IDs stay deduplicated across manager and gateway restarts',
    );
  } finally {
    await gateway.close();
    chat.close();
  }
});
