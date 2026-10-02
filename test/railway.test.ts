import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type {
  ConnectOptions,
  CreateOptions,
  ExecOptions,
  ExecResult,
} from 'railway';
import { HttpError } from '../src/auth.js';
import { createRailwayRuntime } from '../src/railway.js';

const token = 'test-only-railway-token';
const environment = {
  RAILWAY_ENVIRONMENT_ID: 'test-environment',
  RAILWAY_API_TOKEN: token,
  BETTER_AUTH_SECRET: 'must-never-reach-the-vm',
  OPENAI_API_KEY: 'must-never-reach-the-vm-either',
};
const result: ExecResult = {
  exitCode: 0,
  stdout: 'rove-sandbox-ok',
  stderr: '',
  timedOut: false,
  truncated: false,
};
const status = (code: number) => (error: unknown) =>
  error instanceof HttpError && error.status === code;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'rove-sandbox-'));
  const config = {
    baseURL: 'http://localhost:3000',
    authSecret: 'test-only-encryption-secret-32-characters',
    databasePath: join(dir, 'rove.sqlite'),
  };
  const calls = {
    created: [] as CreateOptions[],
    connected: [] as { id: string; options: ConnectOptions }[],
    commands: [] as string[],
    kills: 0,
    destroys: 0,
  };
  let file = '';
  const behavior = {
    createError: false,
    cleanupError: false,
    destructionConfirmed: true,
    execute: async (options: ExecOptions) => {
      options.onStdout?.(result.stdout);
      return result;
    },
  };
  const vm = {
    id: 'test-vm',
    status: 'RUNNING',
    networkIsolation: 'ISOLATED',
    files: {
      write: async (_path: string, value: string) => {
        file = value;
      },
      read: async () => file,
    },
    exec: (command: string, options: ExecOptions) => {
      calls.commands.push(command);
      return Object.assign(
        Promise.resolve().then(() => behavior.execute(options)),
        {
          kill: async () => {
            calls.kills++;
            return true;
          },
        },
      );
    },
    destroy: async () => {
      calls.destroys++;
      if (behavior.cleanupError) throw new Error(token);
      vm.status = behavior.destructionConfirmed ? 'DESTROYED' : 'DESTROYING';
    },
  };
  const sdk = {
    create: async (options: CreateOptions) => {
      calls.created.push(options);
      const inspection = new DatabaseSync(config.databasePath);
      assert.equal(
        inspection
          .prepare(
            "SELECT count(*) AS n FROM rove_sandbox_run WHERE state = 'creating'",
          )
          .get()?.n,
        1,
      );
      inspection.close();
      if (behavior.createError) throw new Error(token);
      vm.status = 'RUNNING';
      return vm;
    },
    connect: async (id: string, options: ConnectOptions) => {
      calls.connected.push({ id, options });
      return vm;
    },
  };
  const runtimes: ReturnType<typeof createRailwayRuntime>[] = [];
  function open(env: NodeJS.ProcessEnv = environment) {
    const runtime = createRailwayRuntime(config, env, sdk);
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { config, open, sdk, vm, calls, behavior };
}

test('setup leaves web operation independent and requires an explicit auth choice when both tokens exist', async (t) => {
  const f = fixture(t);
  for (const env of [{}, { ...environment, RAILWAY_TOKEN: 'project-token' }]) {
    const runtime = f.open(env);
    assert.equal(runtime.status().configured, false);
    assert.equal(runtime.status().executablePlugins, false);
    await assert.rejects(runtime.smoke(), status(503));
  }
  assert.equal(f.calls.created.length, 0);
});

test('trusted smoke persists ownership, uses ISOLATED, separates secrets, and verifies destruction', async (t) => {
  const f = fixture(t);
  const runtime = f.open();
  const completed = await runtime.smoke();
  assert.equal(completed.status, 'passed');
  assert.equal(f.calls.destroys, 1);
  assert.equal(f.calls.commands.length, 1);
  assert.deepEqual(f.calls.created[0]?.env, {
    ROVE_SMOKE_RUN_ID: completed.runId,
  });
  assert.equal(f.calls.created[0]?.networkIsolation, 'ISOLATED');
  assert.equal(f.calls.created[0]?.token, token);
  assert.equal(f.calls.created[0]?.authType, 'bearer');
  assert.equal(f.calls.created[0]?.idleTimeoutMinutes, 1);
  assert.equal(JSON.stringify(runtime.status()).includes(token), false);
  assert.equal(runtime.status().verification, 'required');
  assert.equal(runtime.status().pendingCleanup.length, 0);
  assert.equal(f.calls.connected.length, 2);
});

test('excessive output or cancellation kills the command and independently destroys the VM', async (t) => {
  for (const mode of ['output', 'cancel']) {
    const f = fixture(t);
    const abort = new AbortController();
    f.behavior.execute = async (options) => {
      if (mode === 'output') options.onStdout?.('x'.repeat(16_385));
      else abort.abort();
      return new Promise<ExecResult>(() => {});
    };
    const runtime = f.open();
    await assert.rejects(
      runtime.smoke(abort.signal),
      status(mode === 'output' ? 502 : 408),
    );
    assert.equal(f.calls.kills, 1);
    assert.equal(f.calls.destroys, 1);
    assert.equal(runtime.status().pendingCleanup.length, 0);
  }
});

test('restart retries only owned cleanup and never replays a command', async (t) => {
  const f = fixture(t);
  f.behavior.cleanupError = true;
  const first = f.open();
  await assert.rejects(first.smoke(), status(503));
  await assert.rejects(first.smoke(), status(409));
  assert.equal(first.status().pendingCleanup[0]?.sandboxId, f.vm.id);
  await first.close();
  f.behavior.cleanupError = false;
  const second = f.open();
  await second.reconcile();
  await second.reconcile();
  assert.equal(second.status().pendingCleanup.length, 0);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.commands.length, 1);
  assert.equal(f.calls.destroys, 2);
});

test('unknown creation is visible and blocks retries without deleting unrelated sandboxes', async (t) => {
  const f = fixture(t);
  f.behavior.createError = true;
  const runtime = f.open();
  await assert.rejects(runtime.smoke(), status(503));
  await runtime.reconcile();
  await assert.rejects(runtime.smoke(), status(409));
  assert.equal(runtime.status().pendingCleanup[0]?.state, 'unknown');
  assert.equal(runtime.status().pendingCleanup[0]?.sandboxId, null);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.connected.length, 0);
  assert.equal(f.calls.destroys, 0);
});

test('an accepted destruction request remains pending until provider read-back confirms it', async (t) => {
  const f = fixture(t);
  f.behavior.destructionConfirmed = false;
  const runtime = f.open();
  await assert.rejects(runtime.smoke(), status(503));
  assert.equal(runtime.status().pendingCleanup[0]?.state, 'cleanup');
  await assert.rejects(runtime.smoke(), status(409));
  f.vm.status = 'DESTROYED';
  await runtime.reconcile();
  assert.equal(runtime.status().pendingCleanup.length, 0);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.destroys, 1);
});

test('real SDK uses project-token headers and captured creation identity survives readiness failure', async (t) => {
  const f = fixture(t);
  const requests: { headers: Headers; query: string }[] = [];
  let destroyed = false;
  const transport: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)) as { query: string };
    requests.push({ headers: new Headers(init?.headers), query: body.query });
    const info = {
      id: 'owned-failed-vm',
      status: 'FAILED',
      networkIsolation: 'ISOLATED',
      environmentId: 'test-environment',
    };
    if (body.query.includes('sandboxCreate'))
      return Response.json({ data: { sandboxCreate: info } });
    if (body.query.includes('sandboxDestroy')) {
      destroyed = true;
      return Response.json({ data: { sandboxDestroy: true } });
    }
    return Response.json({ data: { sandbox: destroyed ? null : info } });
  };
  const runtime = createRailwayRuntime(
    f.config,
    {
      ...environment,
      RAILWAY_TOKEN: 'test-project-token',
      ROVE_RAILWAY_AUTH_TYPE: 'project-token',
    },
    undefined,
    transport,
  );
  t.after(() => runtime.close());
  await assert.rejects(runtime.smoke(), status(502));
  assert.equal(destroyed, true);
  assert.equal(runtime.status().pendingCleanup.length, 0);
  assert.ok(requests.length >= 4);
  for (const request of requests) {
    assert.equal(
      request.headers.get('project-access-token'),
      'test-project-token',
    );
    assert.equal(request.headers.get('authorization'), null);
  }
});
