import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { AgentTools } from '../src/agent.js';
import { createChat } from '../src/chat.js';
import type { ToolDefinition } from '../src/provider.js';
import {
  closeRuntime,
  openRuntime,
  type RuntimeConfig,
} from '../src/runtime.js';
import { testConfig, testRuntime } from './storage.js';

const action: ToolDefinition = {
  name: 'company_summary',
  label: 'Company summary',
  description: 'Summarize approved input.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  revision: 'v1',
  surfaces: ['action'],
};

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rove-actions-'));
  let config!: RuntimeConfig;
  let chat!: Awaited<ReturnType<typeof createChat>>;
  let runtimeOpen = false;
  let open = false;
  t.after(async () => {
    if (open) await chat.close();
    if (runtimeOpen) await closeRuntime(config);
  });
  const connection = await testConfig(t);
  config = await openRuntime(connection);
  runtimeOpen = true;
  let catalog: ToolDefinition[] = [{ ...action }];
  const executions: Array<{
    name: string;
    args: Record<string, unknown>;
    revision: string;
    scope: string;
  }> = [];
  const tools: AgentTools = {
    instructions: () => '',
    tools: async () => catalog,
    execute: async (name, args, revision, scope) => {
      executions.push({ name, args, revision, scope });
      return `Result: ${JSON.stringify(args)}`;
    },
  };
  chat = await createChat(config, tools);
  open = true;
  t.after(async () => {
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get config() {
      return config;
    },
    connection,
    directory,
    executions,
    get chat() {
      return chat;
    },
    catalog(value: ToolDefinition[]) {
      catalog = value;
    },
    async stop() {
      await chat.close();
      open = false;
      await closeRuntime(config);
      runtimeOpen = false;
    },
    async restart() {
      if (open) await chat.close();
      if (!runtimeOpen) {
        config = await openRuntime(connection);
        runtimeOpen = true;
      }
      chat = await createChat(config, tools);
      open = true;
    },
  };
}

const request = (args: Record<string, unknown> = { text: 'Handbook' }) => ({
  name: action.name,
  arguments: args,
  requestId: randomUUID(),
});

test('a stale tool completion cannot overwrite a recovered durable result', async (t) => {
  const config = await testRuntime(t);
  let dispatched!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  let executions = 0;
  const chat = await createChat(config, {
    instructions: () => '',
    tools: async () => [action],
    execute: async () => {
      executions++;
      dispatched();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 'Stale completion';
    },
  });
  t.after(() => chat.close());
  const conversation = await chat.create();
  const body = request();
  const waiting = await chat.requestAction(conversation.id, body);
  const approval = { approvalId: waiting.pending?.id, decision: 'approve' };
  const pending = chat.decide(conversation.id, approval);
  const rejected = assert.rejects(pending, /saved action changed/);
  await started;
  const row = await config.db.get('SELECT data FROM rove_run WHERE id=$1', [
    body.requestId,
  ]);
  const run = JSON.parse(String(row?.data));
  run.status = 'done';
  run.answer = 'Recovered outcome';
  await config.db.run('UPDATE rove_run SET data=$1 WHERE id=$2', [
    JSON.stringify(run),
    body.requestId,
  ]);
  finish();
  await rejected;
  const recovered = await chat.decide(conversation.id, approval);
  assert.equal(recovered.messages.at(-1)?.content, 'Recovered outcome');
  assert.equal(executions, 1);
});

test('chat shutdown drains an admitted action before shared storage can close', async (t) => {
  const config = await testRuntime(t);
  let dispatched!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const chat = await createChat(config, {
    instructions: () => '',
    tools: async () => [action],
    execute: async () => {
      dispatched();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 'Confirmed outcome';
    },
  });
  const conversation = await chat.create();
  const waiting = await chat.requestAction(conversation.id, request());
  const active = chat.decide(conversation.id, {
    approvalId: waiting.pending?.id,
    decision: 'approve',
  });
  await started;
  let drained = false;
  const closing = chat.close().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  await assert.rejects(
    chat.requestAction(conversation.id, request()),
    /restarting/,
  );
  finish();
  assert.equal((await active).messages.at(-1)?.content, 'Confirmed outcome');
  await closing;
  assert.equal(drained, true);
});

test('dashboard actions share durable approval and execute once without model configuration', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const body = request({ text: 'Handbook', limit: 2 });
  const waiting = await f.chat.requestAction(conversation.id, body);
  assert.equal((await f.chat.settings()).configured, false);
  assert.equal(waiting.pending?.status, 'waiting');
  assert.equal(waiting.pending?.label, 'Company summary');
  assert.equal(waiting.pending?.prompt, 'Run action: Company summary');
  assert.equal(f.executions.length, 0);
  assert.deepEqual(waiting.pending?.arguments, body.arguments);
  assert.equal(
    (
      await f.chat.requestAction(conversation.id, {
        ...body,
        arguments: { limit: 2, text: 'Handbook' },
      })
    ).pending?.id,
    waiting.pending?.id,
  );
  body.arguments.text = 'Changed after request';
  await f.restart();
  const db = f.config.db;
  await db.run('INSERT INTO rove_model VALUES(1,$1,$2,$3,$4)', [
    'http://localhost:1/v1',
    'unusable',
    '',
    'corrupt-credential',
  ]);
  const approval = {
    approvalId: waiting.pending?.id,
    decision: 'approve',
    arguments: { text: 'Replace approved input' },
  };
  const finished = await f.chat.decide(conversation.id, approval);
  assert.equal(finished.pending, undefined);
  assert.deepEqual(f.executions, [
    {
      name: action.name,
      args: { text: 'Handbook', limit: 2 },
      revision: 'v1',
      scope: `web:${conversation.id}`,
    },
  ]);
  assert.match(finished.messages.at(-1)?.content ?? '', /Handbook/);
  await f.chat.decide(conversation.id, approval);
  f.catalog([]);
  assert.deepEqual(
    (
      await f.chat.requestAction(conversation.id, {
        ...body,
        arguments: { text: 'Handbook', limit: 2 },
      })
    ).messages,
    finished.messages,
  );
  assert.equal(f.executions.length, 1);
});

test('dashboard requests bind the displayed revision and retain retry identity', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const body = { ...request(), revision: 'old' };
  await assert.rejects(f.chat.requestAction(conversation.id, body), /changed/);
  assert.equal((await f.chat.get(conversation.id)).pending, undefined);
  body.revision = 'v1';
  const waiting = await f.chat.requestAction(conversation.id, body);
  await assert.rejects(
    f.chat.requestAction(conversation.id, { ...body, revision: 'v2' }),
    /request ID/,
  );
  await f.chat.decide(conversation.id, {
    approvalId: waiting.pending?.id,
    decision: 'approve',
  });
  f.catalog([{ ...action, revision: 'v2' }]);
  assert.equal(
    (await f.chat.requestAction(conversation.id, body)).pending,
    undefined,
  );
  assert.equal(f.executions.length, 1);
});

test('denial, changed revisions and removed action permissions never execute an action', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  let waiting = await f.chat.requestAction(conversation.id, request());
  f.catalog([{ ...action, revision: 'v2' }]);
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: waiting.pending?.id,
      decision: 'approve',
    }),
    /changed/,
  );
  const denied = await f.chat.decide(conversation.id, {
    approvalId: waiting.pending?.id,
    decision: 'deny',
  });
  assert.match(denied.messages.at(-1)?.content ?? '', /denied/);
  waiting = await f.chat.requestAction(conversation.id, request());
  f.catalog([{ ...action, revision: 'v2', surfaces: ['tool'] }]);
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: waiting.pending?.id,
      decision: 'approve',
    }),
    /changed/,
  );
  await f.chat.decide(conversation.id, {
    approvalId: waiting.pending?.id,
    decision: 'deny',
  });
  for (const surfaces of [undefined, ['tool'], ['step']] as const) {
    f.catalog([{ ...action, surfaces: surfaces ? [...surfaces] : undefined }]);
    await assert.rejects(
      f.chat.requestAction(conversation.id, request()),
      /no longer available/,
    );
  }
  assert.equal(f.executions.length, 0);
});

test('actions reject changed request identities, invalid input and cross-channel ownership', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const other = await f.chat.create();
  const slack = await f.chat.create('slack:team:channel:thread');
  const body = request();
  const admitting = f.chat.requestAction(conversation.id, body);
  await assert.rejects(f.chat.requestAction(other.id, request()), /busy/);
  const waiting = await admitting;
  await assert.rejects(
    f.chat.requestAction(conversation.id, {
      ...body,
      arguments: { text: 'Other' },
    }),
    /request ID/,
  );
  await assert.rejects(
    f.chat.requestAction(conversation.id, { ...body, name: 'different' }),
    /request ID/,
  );
  await assert.rejects(f.chat.requestAction(other.id, body), /request ID/);
  await assert.rejects(f.chat.requestAction(slack.id, request()), /not found/);
  await assert.rejects(
    f.chat.requestAction(conversation.id, {
      ...request(),
      scope: 'slack:team:channel:thread',
    }),
    /Send only/,
  );
  await assert.rejects(
    f.chat.decide(
      conversation.id,
      { approvalId: waiting.pending?.id, decision: 'approve' },
      'slack:team:channel:thread',
    ),
    /not found/,
  );
  await assert.rejects(
    f.chat.decide(other.id, {
      approvalId: waiting.pending?.id,
      decision: 'approve',
    }),
    /no longer pending/,
  );
  await assert.rejects(
    f.chat.requestAction(other.id, { ...request(), requestId: 'x'.repeat(36) }),
    /valid request ID/,
  );
  for (const args of [null, [], 'text', { text: 'x'.repeat(16000) }])
    await assert.rejects(
      f.chat.requestAction(other.id, { ...request(), arguments: args }),
      /JSON object within 16 KB/,
    );
  assert.equal(f.executions.length, 0);
});

test('dashboard actions obey conversation and shutdown limits while completed retries stay safe', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  let last = request();
  for (let index = 0; index < 100; index++) {
    last = request();
    const waiting = await f.chat.requestAction(conversation.id, last);
    await f.chat.decide(conversation.id, {
      approvalId: waiting.pending?.id,
      decision: 'deny',
    });
  }
  await assert.rejects(
    f.chat.requestAction(conversation.id, request()),
    /100 replies/,
  );
  assert.equal(
    (await f.chat.requestAction(conversation.id, last)).messages.length,
    200,
  );
  f.chat.cancelPending();
  await assert.rejects(
    f.chat.requestAction(conversation.id, last),
    /restarting/,
  );
  assert.equal(f.executions.length, 0);
});

test('restart during a dashboard action records its uncertain outcome without replay', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const body = request();
  const waiting = await f.chat.requestAction(conversation.id, body);
  const approval = { approvalId: waiting.pending?.id, decision: 'approve' };
  const marker = join(f.directory, 'effect');
  await f.stop();
  const source = `import {writeFileSync} from 'node:fs';
    import {createChat} from ${JSON.stringify(new URL('../src/chat.js', import.meta.url).href)};
    import {openRuntime} from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const runtime = await openRuntime(${JSON.stringify(f.connection)});
    const chat=await createChat(runtime, {instructions:()=>'',tools:async()=>[${JSON.stringify(action)}],execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');await runtime.state.close();process.exit(42);}});
    await chat.decide(${JSON.stringify(conversation.id)},${JSON.stringify(approval)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 42);
  assert.equal(existsSync(marker), true);
  await f.restart();
  const recovered = await f.chat.get(conversation.id);
  assert.equal(recovered.pending, undefined);
  assert.match(
    recovered.messages.at(-1)?.content ?? '',
    /unknown after restart/,
  );
  await f.chat.decide(conversation.id, approval);
  await f.chat.requestAction(conversation.id, body);
  assert.equal(f.executions.length, 0);
});

test('model calls see default tools and workflow steps while dashboard-only actions stay hidden', async (t) => {
  const f = await fixture(t);
  f.catalog([
    action,
    { ...action, name: 'legacy', surfaces: undefined },
    { ...action, name: 'workflow', surfaces: ['step'] },
  ]);
  const requests: Array<{
    tools: Array<{ function: { name: string } }>;
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await f.chat.saveSettings({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'dummy-key',
    model: 'fixture',
    systemPrompt: '',
  });
  const conversation = await f.chat.create();
  const directBody = request({ text: 'UNTRUSTED_ACTION_RESULT' });
  const direct = await f.chat.requestAction(conversation.id, directBody);
  await f.chat.decide(conversation.id, {
    approvalId: direct.pending?.id,
    decision: 'approve',
  });
  await assert.rejects(
    f.chat.send(conversation.id, {
      content: `Run action: ${action.name}`,
      requestId: directBody.requestId,
    }),
    /request ID/,
  );
  const requestId = randomUUID();
  await f.chat.send(conversation.id, { content: 'Explain', requestId });
  assert.deepEqual(
    requests[0]?.tools.map((tool) => tool.function.name),
    ['legacy', 'workflow'],
  );
  assert.doesNotMatch(
    JSON.stringify(requests[0]?.messages),
    /UNTRUSTED_ACTION_RESULT|Run action:/,
  );
  assert.match(
    JSON.stringify((await f.chat.get(conversation.id)).messages),
    /UNTRUSTED_ACTION_RESULT/,
  );
  await assert.rejects(
    f.chat.requestAction(conversation.id, { ...request(), requestId }),
    /request ID/,
  );
});
