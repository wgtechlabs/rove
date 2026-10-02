import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type { AgentTools } from '../src/agent.js';
import { createChat } from '../src/chat.js';
import type { Config } from '../src/config.js';
import type { ToolDefinition } from '../src/provider.js';

const action: ToolDefinition = {
  name: 'company_summary',
  description: 'Summarize approved input.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  revision: 'v1',
  surfaces: ['action'],
};

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'rove-actions-'));
  const config: Config = {
    databasePath: join(directory, 'rove.sqlite'),
    baseURL: 'http://localhost:3000',
    authSecret: 'test-only-auth-secret-'.repeat(3),
  };
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
  let chat = createChat(config, tools);
  let open = true;
  t.after(() => {
    if (open) chat.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    config,
    directory,
    executions,
    get chat() {
      return chat;
    },
    catalog(value: ToolDefinition[]) {
      catalog = value;
    },
    stop() {
      chat.close();
      open = false;
    },
    restart() {
      if (open) chat.close();
      chat = createChat(config, tools);
      open = true;
    },
  };
}

const request = (args: Record<string, unknown> = { text: 'Handbook' }) => ({
  name: action.name,
  arguments: args,
  requestId: randomUUID(),
});

test('dashboard actions share durable approval and execute once without model configuration', async (t) => {
  const f = fixture(t);
  const conversation = f.chat.create();
  const body = request({ text: 'Handbook', limit: 2 });
  const waiting = await f.chat.requestAction(conversation.id, body);
  assert.equal(f.chat.settings().configured, false);
  assert.equal(waiting.pending?.status, 'waiting');
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
  f.restart();
  const db = new DatabaseSync(f.config.databasePath);
  db.prepare('INSERT INTO rove_model VALUES(1,?,?,?,?)').run(
    'http://localhost:1/v1',
    'unusable',
    '',
    'corrupt-credential',
  );
  db.close();
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

test('denial, changed revisions and removed action permissions never execute an action', async (t) => {
  const f = fixture(t);
  const conversation = f.chat.create();
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
  const f = fixture(t);
  const conversation = f.chat.create();
  const other = f.chat.create();
  const slack = f.chat.create('slack:team:channel:thread');
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
  const f = fixture(t);
  const conversation = f.chat.create();
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
  const f = fixture(t);
  const conversation = f.chat.create();
  const body = request();
  const waiting = await f.chat.requestAction(conversation.id, body);
  const approval = { approvalId: waiting.pending?.id, decision: 'approve' };
  const marker = join(f.directory, 'effect');
  f.stop();
  const source = `import {writeFileSync} from 'node:fs';
    import {createChat} from ${JSON.stringify(new URL('../src/chat.js', import.meta.url).href)};
    const chat=createChat(${JSON.stringify(f.config)}, {instructions:()=>'',tools:async()=>[${JSON.stringify(action)}],execute:async()=>{writeFileSync(${JSON.stringify(marker)},'executed');process.exit(42);}});
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
  f.restart();
  const recovered = f.chat.get(conversation.id);
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
  const f = fixture(t);
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
  f.chat.saveSettings({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'dummy-key',
    model: 'fixture',
    systemPrompt: '',
  });
  const conversation = f.chat.create();
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
    JSON.stringify(f.chat.get(conversation.id).messages),
    /UNTRUSTED_ACTION_RESULT/,
  );
  await assert.rejects(
    f.chat.requestAction(conversation.id, { ...request(), requestId }),
    /request ID/,
  );
});
