import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { createChat } from '../src/chat.js';
import { createExtensions } from '../src/extensions.js';
import { parsePackage } from '../src/plugin-manifest.js';
import type { PluginRuntime } from '../src/plugin-operations.js';
import { createPlugins } from '../src/plugins.js';

const repo = 'example/company-operations';
const signal = () => AbortSignal.timeout(5000);
const packageInput = (version = '1.0.0') => ({
  schemaVersion: 1,
  apiVersion: 1,
  id: 'company-operations',
  name: 'Company operations',
  version,
  category: 'user',
  description: 'Operations from an immutable company release.',
  execution: {
    runtime: 'node',
    source: `export const run = ({ args, settings }) => ({ ...args, ...settings, version: '${version}' });`,
  },
  operations: [
    {
      id: 'summarize',
      name: 'Summarize',
      description: 'Summarize supplied data.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 1000 } },
        required: ['text'],
        additionalProperties: false,
      },
      surfaces: ['tool', 'action', 'step'],
    },
  ],
  pages: [
    {
      id: 'summary',
      title: 'Summary',
      content: 'Prepare a company summary.',
      actions: ['summarize'],
    },
  ],
  settings: [
    {
      key: 'tone',
      label: 'Tone',
      type: 'text',
      required: true,
      default: 'concise',
    },
  ],
  secrets: [{ key: 'private-key', label: 'Private key', required: true }],
  capabilities: ['execute:offline'],
});

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-operations-'));
  const config = {
    baseURL: 'http://localhost:3000',
    authSecret: 'test-operation-auth-secret-'.repeat(3),
    databasePath: join(dir, 'rove.sqlite'),
  };
  const calls: Parameters<PluginRuntime['execute']>[0][] = [];
  const state = {
    bytes: JSON.stringify(packageInput()),
    configured: true,
    environmentId: 'first-environment',
    execute: async (
      input: Parameters<PluginRuntime['execute']>[0],
      _signal: AbortSignal,
    ) => JSON.stringify(input.args),
  };
  const runtime: PluginRuntime = {
    status: () => ({
      configured: state.configured,
      environmentId: state.environmentId,
      authType: 'project-token',
    }),
    execute: async (input, signal) => {
      calls.push(input);
      return state.execute(input, signal);
    },
  };
  const env = { ROVE_PLUGIN_SECRET_TEST: 'test-env-secret-never-pass-to-code' };
  const fetchImpl: typeof fetch = async (input) => {
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
            digest: `sha256:${createHash('sha256').update(state.bytes).digest('hex')}`,
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
  let extensions = createExtensions(config);
  let plugins = createPlugins(config, extensions, fetchImpl, env, runtime);
  const makeChat = () =>
    createChat(config, {
      instructions: () => extensions.instructions(),
      tools: (_scope, signal) => plugins.tools(signal),
      preview: (name, args) => plugins.preview(name, args),
      execute: (name, args, revision, _scope, signal) =>
        plugins.execute(name, args, revision, signal),
    });
  let chat = makeChat();
  t.after(() => {
    chat.close();
    plugins.close();
    extensions.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const current = () => {
    const item = plugins.list().installations[0];
    assert.ok(item);
    return item;
  };
  function configure(
    values: Record<string, string | boolean> = {},
    grants = ['execute:offline'],
  ) {
    const item = current();
    plugins.configure({
      id: item.id,
      revision: item.revision,
      digest: item.versions[0]?.digest,
      values,
      grants,
      secrets: {
        'private-key': {
          source: 'environment',
          name: 'ROVE_PLUGIN_SECRET_TEST',
        },
      },
    });
  }
  return {
    state,
    calls,
    config,
    env,
    get plugins() {
      return plugins;
    },
    get chat() {
      return chat;
    },
    get extensions() {
      return extensions;
    },
    current,
    configure,
    async install(pkg: unknown = packageInput()) {
      state.bytes = JSON.stringify(pkg);
      plugins.saveSource({ repo, approved: true });
      await plugins.install({
        repo,
        tag: `v${(pkg as { version: string }).version}`,
      });
    },
    async activate(digest = current().versions[0]?.digest) {
      const item = current();
      await plugins.activate({ id: item.id, revision: item.revision, digest });
    },
    restart() {
      chat.close();
      plugins.close();
      extensions.close();
      extensions = createExtensions(config);
      plugins = createPlugins(config, extensions, fetchImpl, env, runtime);
      chat = makeChat();
    },
  };
}

test('released actions execute once through persisted chat approval without a model and pass no credentials', async (t) => {
  const f = fixture(t);
  await f.install();
  await assert.rejects(f.activate(), /Grant/);
  f.configure();
  await f.activate();
  const tool = (await f.plugins.tools(signal()))[0];
  assert.ok(tool);
  assert.match(tool.name, /^rove_plugin_[a-f0-9]{40}$/);
  assert.deepEqual(tool.surfaces, ['tool', 'action', 'step']);
  const contribution = f.plugins.contributions().plugins[0];
  assert.equal(contribution?.actions[0]?.name, tool.name);
  assert.deepEqual(contribution?.pages[0]?.actions, [tool.name]);
  assert.equal(f.chat.settings().configured, false);
  const conversation = f.chat.create();
  const request = {
    name: tool.name,
    revision: tool.revision,
    arguments: { text: 'Approved data' },
    requestId: randomUUID(),
  };
  const waiting = await f.chat.requestAction(conversation.id, request);
  assert.equal(f.calls.length, 0);
  assert.equal(waiting.pending?.status, 'waiting');
  assert.match(waiting.pending?.detail ?? '', /Offline custom code/);
  f.restart();
  const decision = { approvalId: waiting.pending?.id, decision: 'approve' };
  const done = await f.chat.decide(conversation.id, decision);
  assert.match(done.messages.at(-1)?.content ?? '', /Approved data/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], {
    source: packageInput().execution.source,
    operation: 'summarize',
    args: request.arguments,
    settings: { tone: 'concise' },
  });
  assert.doesNotMatch(
    JSON.stringify(f.calls),
    /test-env-secret|private-key|ROVE_PLUGIN_SECRET/,
  );
  await f.chat.decide(conversation.id, decision);
  assert.equal(f.calls.length, 1);
});

test('schema, runtime configuration and lifecycle revisions prevent stale or unauthorized dispatch', async (t) => {
  const f = fixture(t);
  await f.install();
  f.configure();
  f.state.configured = false;
  await assert.rejects(f.activate(), /Configure Railway/);
  assert.equal(f.plugins.list().executable.available, false);
  f.state.configured = true;
  await f.activate();
  const original = (await f.plugins.tools(signal()))[0];
  assert.ok(original);
  const oldDigest = f.current().active;
  assert.ok(oldDigest);
  for (const input of [{ text: 4 }, { text: 'ok', extra: true }, {}])
    await assert.rejects(
      f.plugins.execute(original.name, input, original.revision, signal()),
      /input schema/,
    );
  assert.equal(f.calls.length, 0);
  const conversation = f.chat.create();
  const pending = await f.chat.requestAction(conversation.id, {
    name: original.name,
    revision: original.revision,
    arguments: { text: 'stale' },
    requestId: randomUUID(),
  });
  f.state.environmentId = 'different-environment';
  f.restart();
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: pending.pending?.id,
      decision: 'approve',
    }),
    /changed/,
  );
  assert.equal(f.calls.length, 0);
  f.state.environmentId = 'first-environment';
  f.restart();
  f.configure({ tone: 'detailed' });
  await f.activate();
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: pending.pending?.id,
      decision: 'approve',
    }),
    /changed/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    f.plugins.execute(
      original.name,
      { text: 'stale' },
      original.revision,
      signal(),
    ),
    /changed/,
  );
  await f.install(packageInput('2.0.0'));
  await f.activate();
  const updated = (await f.plugins.tools(signal()))[0];
  assert.ok(updated);
  assert.equal(updated.name, original.name);
  assert.notEqual(updated.revision, original.revision);
  await f.plugins.execute(
    updated.name,
    { text: 'new' },
    updated.revision,
    signal(),
  );
  assert.equal(f.calls.at(-1)?.source, packageInput('2.0.0').execution.source);
  await f.activate(oldDigest);
  f.restart();
  const restored = (await f.plugins.tools(signal()))[0];
  assert.ok(restored);
  await f.plugins.execute(
    restored.name,
    { text: 'restored' },
    restored.revision,
    signal(),
  );
  assert.equal(f.calls.at(-1)?.source, packageInput().execution.source);
  f.env.ROVE_PLUGIN_SECRET_TEST = 'rotated-value';
  assert.deepEqual(await f.plugins.tools(signal()), []);
  await assert.rejects(
    f.plugins.execute(restored.name, {}, restored.revision, signal()),
    /no longer enabled/,
  );
  f.restart();
  assert.equal(f.current().active, null);
  await f.activate();
  f.plugins.saveSource({ repo, approved: false });
  assert.deepEqual(f.plugins.contributions(), { plugins: [] });
  assert.deepEqual(await f.plugins.tools(signal()), []);
  assert.equal(f.calls.length, 2);
});

test('in-flight calls block configuration, release and source changes, and shutdown aborts dispatch', async (t) => {
  const f = fixture(t);
  await f.install();
  f.configure();
  await f.activate();
  const tool = (await f.plugins.tools(signal()))[0];
  assert.ok(tool);
  let began = () => {};
  let reject = (_reason: unknown) => {};
  const begun = new Promise<void>((resolve) => {
    began = resolve;
  });
  const finish = new Promise<string>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  f.state.execute = async (_input, signal) => {
    began();
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
    return finish;
  };
  const execution = f.plugins.execute(
    tool.name,
    { text: 'working' },
    tool.revision,
    signal(),
  );
  await begun;
  assert.throws(() => f.configure(), /current plugin call/);
  assert.throws(
    () => f.plugins.saveSource({ repo, approved: false }),
    /current plugin call/,
  );
  assert.throws(
    () =>
      f.plugins.deactivate({
        id: f.current().id,
        revision: f.current().revision,
      }),
    /current plugin call/,
  );
  await assert.rejects(f.activate(), /current plugin call/);
  await assert.rejects(
    f.plugins.install({ repo, tag: 'v2.0.0' }),
    /current plugin call/,
  );
  await assert.rejects(
    f.plugins.execute(tool.name, { text: 'overlap' }, tool.revision, signal()),
    /current plugin call/,
  );
  f.plugins.close();
  await assert.rejects(execution, /abort/i);
  assert.equal(f.calls.length, 1);
});

test('static pages need no runtime and plugin operations share the MCP tool ceiling', async (t) => {
  const f = fixture(t);
  const staticPage = {
    ...packageInput(),
    execution: undefined,
    operations: [],
    capabilities: [],
    secrets: [],
    pages: [
      { id: 'policy', title: 'Policy', content: 'Read-only company guidance.' },
    ],
  };
  f.state.configured = false;
  await f.install(staticPage);
  await f.activate();
  assert.equal(f.plugins.contributions().plugins[0]?.pages[0]?.title, 'Policy');
  assert.deepEqual(await f.plugins.tools(signal()), []);
  f.state.configured = true;
  await f.install(packageInput('2.0.0'));
  f.configure();
  const server = f.extensions.save({
    kind: 'server',
    name: 'Configured MCP',
    url: 'https://tools.example/mcp',
    enabled: false,
  }).servers[0];
  assert.ok(server);
  const db = new DatabaseSync(f.config.databasePath);
  try {
    const row = db
      .prepare('SELECT data FROM rove_extension WHERE id=?')
      .get(server.id);
    assert.ok(row);
    db.prepare('UPDATE rove_extension SET data=?,tools=? WHERE id=?').run(
      JSON.stringify({ ...JSON.parse(String(row.data)), enabled: true }),
      JSON.stringify(
        Array.from({ length: 32 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: 'object' },
        })),
      ),
      server.id,
    );
    await assert.rejects(f.activate(), /at most 32 MCP and plugin/);
    assert.equal(f.current().active, null);
    db.prepare('UPDATE rove_extension SET tools=? WHERE id=?').run(
      '[]',
      server.id,
    );
    await f.activate();
    assert.equal((await f.plugins.tools(signal())).length, 1);
    db.prepare('UPDATE rove_extension SET tools=? WHERE id=?').run(
      JSON.stringify(
        Array.from({ length: 32 }, (_, index) => ({
          name: `tool_${index}`,
          inputSchema: { type: 'object' },
        })),
      ),
      server.id,
    );
    await assert.rejects(
      f.plugins.tools(signal()),
      /at most 32 MCP and plugin/,
    );
  } finally {
    db.close();
  }
  assert.equal(parsePackage(staticPage).operations.length, 0);
});
