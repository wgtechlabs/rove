import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type {
  ConnectOptions,
  CreateOptions,
  ExecOptions,
  ExecResult,
} from 'railway';
import { HttpError } from '../src/auth.js';
import { createRailwayRuntime } from '../src/railway.js';
import { testRuntime } from './storage.js';

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

async function fixture(t: TestContext) {
  const config = {
    ...(await testRuntime(t)),
    baseURL: 'http://localhost:3000',
    authSecret: 'test-only-encryption-secret-32-characters',
  };
  const calls = {
    files: [] as { path: string; value: string }[],
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
      write: async (path: string, value: string) => {
        calls.files.push({ path, value });
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
      const inspection = config.db;
      assert.equal(
        (
          await inspection.get(
            "SELECT count(*) AS n FROM rove_sandbox_run WHERE state = 'creating'",
            [],
          )
        )?.n,
        1,
      );
      if (behavior.createError) throw new Error(token);
      vm.status = 'RUNNING';
      return vm;
    },
    connect: async (id: string, options: ConnectOptions) => {
      calls.connected.push({ id, options });
      return vm;
    },
  };
  const runtimes: Awaited<ReturnType<typeof createRailwayRuntime>>[] = [];
  async function open(env: NodeJS.ProcessEnv = environment) {
    const runtime = await createRailwayRuntime(config, env, sdk);
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
  });
  return { config, open, sdk, vm, calls, behavior };
}

test('setup leaves web operation independent and requires an explicit auth choice when both tokens exist', async (t) => {
  const f = await fixture(t);
  for (const env of [{}, { ...environment, RAILWAY_TOKEN: 'project-token' }]) {
    const runtime = await f.open(env);
    assert.equal((await runtime.status()).configured, false);
    assert.equal((await runtime.status()).executablePlugins, false);
    await assert.rejects(runtime.smoke(), status(503));
  }
  assert.equal(f.calls.created.length, 0);
});

test('trusted smoke persists ownership, uses ISOLATED, separates secrets, and verifies destruction', async (t) => {
  const f = await fixture(t);
  const runtime = await f.open();
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
  assert.equal(JSON.stringify(await runtime.status()).includes(token), false);
  assert.equal((await runtime.status()).verification, 'not-run');
  assert.equal((await runtime.status()).pendingCleanup.length, 0);
  assert.equal(f.calls.connected.length, 2);
});

test('excessive output or cancellation kills the command and independently destroys the VM', async (t) => {
  for (const mode of ['output', 'cancel']) {
    const f = await fixture(t);
    const abort = new AbortController();
    f.behavior.execute = async (options) => {
      if (mode === 'output') options.onStdout?.('x'.repeat(16_385));
      else abort.abort();
      return new Promise<ExecResult>(() => {});
    };
    const runtime = await f.open();
    await assert.rejects(
      runtime.smoke(abort.signal),
      status(mode === 'output' ? 502 : 408),
    );
    assert.equal(f.calls.kills, 1);
    assert.equal(f.calls.destroys, 1);
    assert.equal((await runtime.status()).pendingCleanup.length, 0);
  }
});

test('restart retries only owned cleanup and never replays a command', async (t) => {
  const f = await fixture(t);
  f.behavior.cleanupError = true;
  const first = await f.open();
  await assert.rejects(first.smoke(), status(503));
  await assert.rejects(first.smoke(), status(409));
  assert.equal((await first.status()).pendingCleanup[0]?.sandboxId, f.vm.id);
  await first.close();
  f.behavior.cleanupError = false;
  const second = await f.open();
  await second.reconcile();
  await second.reconcile();
  assert.equal((await second.status()).pendingCleanup.length, 0);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.commands.length, 1);
  assert.equal(f.calls.destroys, 2);
});

test('unknown creation is visible and blocks retries without deleting unrelated sandboxes', async (t) => {
  const f = await fixture(t);
  f.behavior.createError = true;
  const runtime = await f.open();
  await assert.rejects(runtime.smoke(), status(503));
  await runtime.reconcile();
  await assert.rejects(runtime.smoke(), status(409));
  assert.equal((await runtime.status()).pendingCleanup[0]?.state, 'unknown');
  assert.equal((await runtime.status()).pendingCleanup[0]?.sandboxId, null);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.connected.length, 0);
  assert.equal(f.calls.destroys, 0);
});

test('an accepted destruction request remains pending until provider read-back confirms it', async (t) => {
  const f = await fixture(t);
  f.behavior.destructionConfirmed = false;
  const runtime = await f.open();
  await assert.rejects(runtime.smoke(), status(503));
  assert.equal((await runtime.status()).pendingCleanup[0]?.state, 'cleanup');
  await assert.rejects(runtime.smoke(), status(409));
  f.vm.status = 'DESTROYED';
  await runtime.reconcile();
  assert.equal((await runtime.status()).pendingCleanup.length, 0);
  assert.equal(f.calls.created.length, 1);
  assert.equal(f.calls.destroys, 1);
});

test('real SDK uses project-token headers and captured creation identity survives readiness failure', async (t) => {
  const f = await fixture(t);
  const requests: { headers: Headers; query: string }[] = [];
  let destroyed = false;
  const transport: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)) as {
      query: string;
      variables: { input?: { resources: { cpu: number; memoryGB: number } } };
    };
    requests.push({ headers: new Headers(init?.headers), query: body.query });
    const info = {
      id: 'owned-failed-vm',
      status: 'FAILED',
      networkIsolation: 'ISOLATED',
      environmentId: 'test-environment',
    };
    if (body.query.includes('sandboxCreate')) {
      assert.deepEqual(body.variables.input?.resources, {
        cpu: 1,
        memoryGB: 2,
      });
      return Response.json({ data: { sandboxCreate: info } });
    }
    if (body.query.includes('sandboxDestroy')) {
      destroyed = true;
      return Response.json({ data: { sandboxDestroy: true } });
    }
    return Response.json({ data: { sandbox: destroyed ? null : info } });
  };
  const runtime = await createRailwayRuntime(
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
  assert.equal((await runtime.status()).pendingCleanup.length, 0);
  assert.ok(requests.length >= 4);
  for (const request of requests) {
    assert.equal(
      request.headers.get('project-access-token'),
      'test-project-token',
    );
    assert.equal(request.headers.get('authorization'), null);
  }
});

const operation = {
  source:
    'export async function run({ args }) { return { total: args.quantity * 2 }; }',
  operation: 'calculate',
  args: { quantity: 3 },
  settings: { label: 'demo', enabled: true },
};

test('offline execution writes a guarded runner, returns bounded results only after confirmed destruction, and never forwards credentials', async (t) => {
  const f = await fixture(t);
  f.behavior.execute = async (options) => {
    const stdout = JSON.stringify({ result: { total: 6 } });
    options.onStdout?.(stdout);
    return { ...result, stdout };
  };
  const runtime = await f.open();
  assert.equal((await runtime.status()).executablePlugins, true);
  assert.equal((await runtime.status()).verification, 'not-run');
  assert.equal(
    await runtime.execute(operation, new AbortController().signal),
    '{"total":6}',
  );
  assert.equal(f.calls.destroys, 1);
  assert.equal(f.calls.connected.length, 2);
  assert.equal(f.calls.files[0]?.path, '/tmp/rove-runner.sh');
  const script = f.calls.files[0]?.value || '';
  assert.match(script, /cgroup.kill/);
  assert.match(script, /--net --pid --mount/);
  assert.equal(script.includes(operation.source), false);
  assert.equal(script.includes(token), false);
  assert.equal(script.includes(environment.BETTER_AUTH_SECRET), false);
  assert.deepEqual(Object.keys(f.calls.created[0]?.env || {}), [
    'ROVE_SMOKE_RUN_ID',
  ]);
  assert.deepEqual(f.calls.commands, [
    '/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /bin/sh /tmp/rove-runner.sh',
  ]);
  assert.equal((await runtime.status()).pendingCleanup.length, 0);
  // Controlled SDK results never promote the separate live-verification claim.
  assert.equal((await runtime.status()).verification, 'not-run');
});

test('invalid inputs and already-cancelled calls never create a sandbox', async (t) => {
  const f = await fixture(t);
  const runtime = await f.open();
  await assert.rejects(
    runtime.execute({ ...operation, source: '' }, new AbortController().signal),
    status(400),
  );
  await assert.rejects(runtime.execute(operation, AbortSignal.abort()));
  assert.equal(f.calls.created.length, 0);
  assert.equal((await runtime.status()).pendingCleanup.length, 0);
});

test('shutdown during database admission never dispatches a sandbox or leaves a cleanup intent', async (t) => {
  for (const phase of ['admission', 'intent']) {
    const f = await fixture(t);
    const runtime = await f.open();
    let notify!: () => void;
    const entered = new Promise<void>((resolve) => {
      notify = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const method = phase === 'admission' ? 'all' : 'run';
    const original = f.config.db[method];
    let paused = false;
    const mock = t.mock.method(
      f.config.db,
      method,
      async (sql: string, params?: unknown[]) => {
        const rows = await original(sql, params);
        if (
          !paused &&
          sql.includes(
            phase === 'admission'
              ? "WHERE state != 'complete'"
              : 'INSERT INTO rove_sandbox_run',
          )
        ) {
          paused = true;
          notify();
          await released;
        }
        return rows;
      },
    );
    const rejected = assert.rejects(runtime.smoke());
    await entered;
    let drained = false;
    const closing = runtime.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    resume();
    await Promise.all([rejected, closing]);
    mock.mock.restore();
    assert.equal(f.calls.created.length, 0);
    assert.equal((await runtime.status()).pendingCleanup.length, 0);
  }
});

test('lost Redis ownership still destroys the exact owned sandbox without changing its durable record', async (t) => {
  for (const phase of ['creation', 'execution']) {
    const f = await fixture(t);
    const runtime = await f.open();
    if (phase === 'creation') {
      const create = f.sdk.create;
      t.mock.method(f.sdk, 'create', async (options: CreateOptions) => {
        const vm = await create(options);
        await f.config.state.close();
        return vm;
      });
    } else {
      f.behavior.execute = async () => {
        await f.config.state.close();
        return new Promise<ExecResult>(() => {});
      };
    }
    await assert.rejects(runtime.smoke());
    assert.equal(f.calls.created.length, 1);
    assert.equal(f.calls.destroys, 1);
    assert.equal(
      f.calls.connected.every((call) => call.id === f.vm.id),
      true,
    );
    assert.equal((await runtime.status()).pendingCleanup.length, 1);
    await assert.rejects(runtime.smoke(), status(503));
    assert.equal(f.calls.created.length, 1);
  }
});

test('native boundary failure, invalid output, cancellation, and cleanup failure never return operation success', async (t) => {
  for (const mode of ['isolation', 'result', 'output', 'cancel', 'cleanup']) {
    const f = await fixture(t);
    const abort = new AbortController();
    f.behavior.cleanupError = mode === 'cleanup';
    f.behavior.execute = async (options) => {
      if (mode === 'cancel') {
        abort.abort();
        return new Promise<ExecResult>(() => {});
      }
      if (mode === 'output') options.onStderr?.('x'.repeat(16_385));
      return {
        ...result,
        exitCode: mode === 'isolation' ? 1 : 0,
        stdout: mode === 'result' ? 'unexpected output' : '{"result":"ok"}',
        stderr:
          mode === 'isolation'
            ? 'rove-runner-failed: writable-cgroup-v2-required'
            : '',
      };
    };
    const runtime = await f.open();
    await assert.rejects(
      runtime.execute(operation, abort.signal),
      status(mode === 'cancel' ? 408 : mode === 'cleanup' ? 503 : 502),
    );
    assert.equal(f.calls.destroys, 1);
    if (mode === 'cleanup') {
      assert.equal((await runtime.status()).pendingCleanup.length, 1);
      await assert.rejects(
        runtime.execute(operation, abort.signal),
        status(409),
      );
    } else assert.equal((await runtime.status()).pendingCleanup.length, 0);
  }
});
