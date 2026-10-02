import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { AgentTools } from '../src/agent.js';
import { createChat } from '../src/chat.js';
import {
  closeRuntime,
  openRuntime,
  type RuntimeConfig,
} from '../src/runtime.js';
import { testConfig } from './storage.js';

const definition = {
  name: 'company_lookup',
  description: 'Read company information.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
  revision: 'v1',
};
const modelCall = () => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: randomUUID(),
            type: 'function',
            function: {
              name: definition.name,
              arguments: JSON.stringify({ query: 'Handbook' }),
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
});
const modelAnswer = () => ({
  choices: [
    { message: { content: 'Verified answer.' }, finish_reason: 'stop' },
  ],
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rove-agent-'));
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
  const requests: Array<{
    tools?: unknown[];
    messages: Array<{ role: string; content?: string }>;
    parallel_tool_calls?: boolean;
  }> = [];
  const executions: Array<{
    name: string;
    args: Record<string, unknown>;
    scope: string;
    revision: string;
  }> = [];
  let toolRevision = 'v1';
  let responder = (response: ServerResponse) =>
    response.end(JSON.stringify(modelCall()));
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer dummy-model-key');
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.setHeader('Content-Type', 'application/json');
    responder(response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const tools: AgentTools = {
    instructions: () => 'Company rules: verify every answer.',
    tools: async () => [{ ...definition, revision: toolRevision }],
    execute: async (name, args, revision, scope) => {
      executions.push({ name, args, revision, scope });
      return 'The handbook confirms the answer.';
    },
  };
  chat = await createChat(config, tools);
  open = true;
  await chat.saveSettings({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'dummy-model-key',
    model: 'local-model',
    systemPrompt: 'Answer in plain English.',
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get config() {
      return config;
    },
    connection,
    directory,
    requests,
    executions,
    get chat() {
      return chat;
    },
    answer() {
      responder = (response) => response.end(JSON.stringify(modelAnswer()));
    },
    fail() {
      responder = (response) => response.writeHead(503).end();
    },
    call() {
      responder = (response) => response.end(JSON.stringify(modelCall()));
    },
    changeTool() {
      toolRevision = 'v2';
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

test('a real provider tool request waits for approval, binds arguments, and isolates source scopes', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create('slack:team:channel:thread');
  const body = { content: 'Look up the handbook', requestId: randomUUID() };
  const result = await f.chat.send(
    conversation.id,
    body,
    'slack:team:channel:thread',
  );
  assert.ok(result.pending);
  assert.equal(result.pending.status, 'waiting');
  assert.deepEqual(result.pending.arguments, { query: 'Handbook' });
  assert.equal(f.executions.length, 0);
  assert.equal(f.requests[0]?.parallel_tool_calls, false);
  await assert.rejects(
    async () => await f.chat.get(conversation.id),
    /not found/,
  );
  assert.deepEqual(await f.chat.list(), []);
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: result.pending.id,
      decision: 'approve',
    }),
    /not found/,
  );
  f.answer();
  const finished = await f.chat.decide(
    conversation.id,
    {
      approvalId: result.pending.id,
      decision: 'approve',
      arguments: { query: 'Unapproved replacement' },
    },
    'slack:team:channel:thread',
  );
  assert.equal(finished.pending, undefined);
  assert.deepEqual(f.executions, [
    {
      name: definition.name,
      args: { query: 'Handbook' },
      revision: 'v1',
      scope: `slack:team:channel:thread:${conversation.id}`,
    },
  ]);
  assert.equal(finished.title, body.content);
  assert.deepEqual(finished.messages, [
    { role: 'user', content: body.content },
    { role: 'assistant', content: 'Verified answer.' },
  ]);
  assert.match(f.requests.at(-1)?.messages[0]?.content ?? '', /untrusted/i);
  const repeated = await f.chat.decide(
    conversation.id,
    { approvalId: result.pending.id, decision: 'approve' },
    'slack:team:channel:thread',
  );
  assert.deepEqual(repeated.messages, finished.messages);
  assert.equal(f.executions.length, 1);
});

test('stale tool approvals fail closed and denial continues without calling the tool', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const waiting = await f.chat.send(conversation.id, {
    content: 'Use the lookup',
    requestId: randomUUID(),
  });
  assert.ok(waiting.pending);
  f.changeTool();
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: waiting.pending.id,
      decision: 'approve',
    }),
    /changed/,
  );
  assert.equal(f.executions.length, 0);
  assert.equal(f.requests.length, 1);
  f.answer();
  await f.chat.decide(conversation.id, {
    approvalId: waiting.pending.id,
    decision: 'deny',
  });
  assert.equal(f.executions.length, 0);
  assert.match(f.requests.at(-1)?.messages.at(-1)?.content ?? '', /denied/i);
});

test('model continuation failure and restart never replay an approved tool call', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const body = { content: 'Read the handbook', requestId: randomUUID() };
  const waiting = await f.chat.send(conversation.id, body);
  assert.ok(waiting.pending);
  f.fail();
  await assert.rejects(
    f.chat.decide(conversation.id, {
      approvalId: waiting.pending.id,
      decision: 'approve',
    }),
    /provider/,
  );
  assert.equal(f.executions.length, 1);
  assert.equal((await f.chat.get(conversation.id)).pending?.status, 'ready');
  await f.restart();
  f.answer();
  const complete = await f.chat.decide(conversation.id, {
    approvalId: waiting.pending.id,
    decision: 'approve',
  });
  assert.equal(complete.pending, undefined);
  assert.equal(f.executions.length, 1);
  assert.match(
    f.requests.at(-1)?.messages.at(-1)?.content ?? '',
    /handbook confirms/,
  );
  const count = f.requests.length;
  await f.chat.send(conversation.id, body);
  assert.equal(f.requests.length, count);
});

test('process exit during dispatch recovers an unknown outcome without replaying the action', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  const waiting = await f.chat.send(conversation.id, {
    content: 'Perform a lookup',
    requestId: randomUUID(),
  });
  assert.ok(waiting.pending);
  const marker = join(f.directory, 'external-action');
  await f.stop();
  const source = `import {writeFileSync} from 'node:fs';
    import {createChat} from ${JSON.stringify(new URL('../src/chat.js', import.meta.url).href)};
    import {openRuntime} from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const runtime = await openRuntime(${JSON.stringify(f.connection)});
    const chat=await createChat(runtime, {instructions:()=>'',tools:async()=>[${JSON.stringify(definition)}],execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');await runtime.state.close();process.exit(42);}});
    await chat.decide(${JSON.stringify(conversation.id)},${JSON.stringify({ approvalId: waiting.pending.id, decision: 'approve' })});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exit, 42);
  assert.equal(existsSync(marker), true);
  await f.restart();
  assert.equal((await f.chat.get(conversation.id)).pending?.status, 'ready');
  f.answer();
  await f.chat.decide(conversation.id, {
    approvalId: waiting.pending.id,
    decision: 'approve',
  });
  assert.equal(f.executions.length, 0);
  assert.match(
    f.requests.at(-1)?.messages.at(-1)?.content ?? '',
    /unknown after restart/i,
  );
});

test('the shared runtime stops offering tools after six separately approved calls', async (t) => {
  const f = await fixture(t);
  const conversation = await f.chat.create();
  let result = await f.chat.send(conversation.id, {
    content: 'Work through the lookup',
    requestId: randomUUID(),
  });
  for (let step = 0; step < 6; step++) {
    assert.ok(result.pending);
    assert.equal(f.executions.length, step);
    if (step === 5) f.answer();
    result = await f.chat.decide(conversation.id, {
      approvalId: result.pending.id,
      decision: 'approve',
    });
  }
  assert.equal(result.pending, undefined);
  assert.equal(f.executions.length, 6);
  assert.equal(f.requests.at(-1)?.tools, undefined);
});

test('completed approval recovers after exchange persistence failure and cannot overwrite or approve future turns', async (t) => {
  const f = await fixture(t);
  const scope = 'slack:recovery:channel:thread';
  const conversation = await f.chat.create(scope);
  const first = {
    content: 'Original conversation title',
    requestId: randomUUID(),
  };
  const waiting = await f.chat.send(conversation.id, first, scope);
  assert.ok(waiting.pending);
  const approval = { approvalId: waiting.pending.id, decision: 'approve' };
  const db = f.config.db;
  await db.exec(`CREATE FUNCTION fail_exchange() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'simulated exchange persistence failure'; END $$;
    CREATE TRIGGER fail_exchange BEFORE INSERT ON rove_exchange FOR EACH ROW EXECUTE FUNCTION fail_exchange()`);
  f.answer();
  await assert.rejects(
    f.chat.decide(conversation.id, approval, scope),
    /simulated exchange persistence failure/,
  );
  assert.equal(f.executions.length, 1);
  assert.equal(
    (await db.get('SELECT COUNT(*) AS n FROM rove_exchange', []))?.n,
    0,
  );
  const savedRun = JSON.parse(
    String(
      (await db.get('SELECT data FROM rove_run WHERE id=$1', [first.requestId]))
        ?.data,
    ),
  );
  assert.equal(savedRun.status, 'done');
  await db.exec('DROP TRIGGER fail_exchange ON rove_exchange');
  await f.restart();
  await assert.rejects(
    async () => await f.chat.get(conversation.id),
    /not found/,
  );
  const recovered = await f.chat.get(conversation.id, scope);
  assert.equal(recovered.title, first.content);
  assert.deepEqual(recovered.messages, [
    { role: 'user', content: first.content },
    { role: 'assistant', content: 'Verified answer.' },
  ]);
  assert.equal(recovered.pending, undefined);
  const count = f.requests.length;
  const retry = await f.chat.decide(conversation.id, approval, scope);
  assert.deepEqual(retry.messages, recovered.messages);
  assert.equal(f.requests.length, count);
  assert.equal(f.executions.length, 1);

  await f.chat.send(
    conversation.id,
    { content: 'A later conversation turn', requestId: randomUUID() },
    scope,
  );
  const later = await f.chat.get(conversation.id, scope);
  const oldRetry = await f.chat.decide(conversation.id, approval, scope);
  assert.equal(oldRetry.title, first.content);
  assert.deepEqual(oldRetry.messages, later.messages);
  assert.equal(oldRetry.messages.length, 4);
  assert.equal(f.executions.length, 1);

  f.call();
  const next = await f.chat.send(
    conversation.id,
    {
      content: 'A new action needing its own approval',
      requestId: randomUUID(),
    },
    scope,
  );
  assert.ok(next.pending);
  const requestsBeforeReplay = f.requests.length;
  const preserved = await f.chat.decide(conversation.id, approval, scope);
  assert.equal(preserved.pending?.id, next.pending.id);
  assert.equal(preserved.title, first.content);
  assert.deepEqual(preserved.messages, next.messages);
  assert.equal(f.requests.length, requestsBeforeReplay);
  assert.equal(f.executions.length, 1);
  await assert.rejects(f.chat.decide(conversation.id, approval), /not found/);
});
