import { randomUUID } from 'node:crypto';
import {
  type ConnectOptions,
  type CreateOptions,
  type ExecOptions,
  type ExecResult,
  Sandbox,
  SandboxNotFoundError,
} from 'railway';
import { HttpError } from './auth.js';
import type { RuntimeConfig } from './runtime.js';
import {
  SANDBOX_COMMAND,
  SANDBOX_OUTPUT_BYTES,
  type SandboxInput,
  sandboxResult,
  sandboxRunner,
} from './sandbox-runner.js';

const DEADLINE_MS = 120_000;
const OUTPUT_BYTES = SANDBOX_OUTPUT_BYTES;
const MARKER = 'rove-sandbox-smoke';
const COMMAND =
  'test "$(cat /tmp/rove-smoke.txt)" = rove-sandbox-smoke && ' +
  'test -z "$RAILWAY_API_TOKEN$RAILWAY_TOKEN$BETTER_AUTH_SECRET" && ' +
  "printf 'rove-sandbox-ok'";

type Command = PromiseLike<ExecResult> & {
  kill(signal: 'KILL'): Promise<boolean>;
};
type Instance = {
  id: string;
  status: string;
  networkIsolation: string;
  files: {
    write(path: string, data: string): Promise<void>;
    read(
      path: string,
      format: 'text',
      options: { length: number },
    ): Promise<string>;
  };
  exec(command: string, options: ExecOptions): Command;
  destroy(): Promise<void>;
};

type Sdk = {
  create(options: CreateOptions): Promise<Instance>;
  connect(id: string, options: ConnectOptions): Promise<Instance>;
};

type Run = {
  id: string;
  environment_id: string;
  sandbox_id: string | null;
  state: 'creating' | 'cleanup' | 'unknown' | 'complete';
  deadline: number;
};

function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new HttpError(408, 'Sandbox operation cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort);
      });
    if (signal.aborted) abort();
  });
}

/** Fresh owned VMs for fixed smoke checks and guarded offline plugin execution. */
export async function createRailwayRuntime(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  sdk: Sdk = Sandbox,
  fetchImplementation: typeof fetch = fetch,
) {
  const db = config.db;
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_sandbox_run (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL,
      sandbox_id TEXT, state TEXT NOT NULL, deadline BIGINT NOT NULL,
      created_at BIGINT NOT NULL, outcome TEXT NOT NULL DEFAULT 'uncertain'
    )`);
  const environmentId =
    env.ROVE_SANDBOX_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_ID || '';
  const choice = env.ROVE_RAILWAY_AUTH_TYPE;
  const both = !!env.RAILWAY_API_TOKEN && !!env.RAILWAY_TOKEN;
  const authType =
    choice || (both ? '' : env.RAILWAY_TOKEN ? 'project-token' : 'bearer');
  const token =
    authType === 'project-token' ? env.RAILWAY_TOKEN : env.RAILWAY_API_TOKEN;
  const configured =
    !!token &&
    !!environmentId &&
    ['bearer', 'project-token'].includes(authType);
  let active:
    | Promise<{ runId: string; status: 'passed'; output: string }>
    | undefined;
  let controller: AbortController | undefined;
  let reconciling: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  async function pending() {
    return (await db.all(
      "SELECT * FROM rove_sandbox_run WHERE state != 'complete' ORDER BY created_at",
      [],
    )) as Run[];
  }

  async function status() {
    return {
      provider: 'railway',
      configured,
      environmentId: environmentId || null,
      authType: configured ? authType : null,
      setupNeeded: !configured,
      verification: 'not-run',
      executablePlugins: configured && !closed,
      network: 'offline-plugin-network-namespace',
      limitations: [
        'Live Railway containment and crash cleanup have not been verified.',
        'Each invocation requires Linux namespaces, delegated cgroup v2 limits, and a minimal Node runtime; missing capabilities reject execution.',
        'Plugins run offline without credentials. External actions use separately approved MCP tools.',
      ],
      pendingCleanup: (await pending()).map((row) => ({
        id: row.id,
        environmentId: row.environment_id,
        sandboxId: row.sandbox_id,
        state: row.state,
        deadline: Number(row.deadline),
      })),
    };
  }

  function connection(
    environment: string,
    signal?: AbortSignal,
    record?: Run,
  ): ConnectOptions {
    return {
      token,
      authType: authType === 'project-token' ? 'project-token' : 'bearer',
      environmentId: environment,
      endpoint: 'https://backboard.railway.com/graphql/v2',
      tcpProxyWsEndpoint: 'wss://ssh.railway.com:2226/ws/exec',
      verbose: false,
      fetch: async (input, init) => {
        const signals = [AbortSignal.timeout(10_000)];
        if (signal) signals.push(signal);
        if (init?.signal) signals.push(init.signal);
        // The pinned SDK omits API resource options. Add them only to our
        // create request; guest cgroups independently enforce tighter limits.
        let body = init?.body;
        const creating =
          record && typeof body === 'string' && body.includes('sandboxCreate');
        if (creating) {
          const request = JSON.parse(body as string);
          request.variables.input.resources = { cpu: 1, memoryGB: 2 };
          body = JSON.stringify(request);
        }
        const response = await fetchImplementation(input, {
          ...init,
          body,
          redirect: 'error',
          signal: AbortSignal.any(signals),
        });
        // Persist identity before the SDK's readiness polling, which can fail after creation.
        if (creating) {
          const body = (await response.clone().json()) as {
            data?: { sandboxCreate?: { id?: unknown } };
          };
          const id = body.data?.sandboxCreate?.id;
          if (typeof id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(id)) {
            record.sandbox_id = id;
            await db.run(
              'UPDATE rove_sandbox_run SET sandbox_id = $1, state = $2 WHERE id = $3',
              [id, 'cleanup', record.id],
            );
          }
        }
        return response;
      },
    };
  }

  async function destroy(row: Run) {
    const recordState = async (state: Run['state']) => {
      if (config.state.signal.aborted) return;
      try {
        await db.run('UPDATE rove_sandbox_run SET state = $1 WHERE id = $2', [
          state,
          row.id,
        ]);
      } catch (error) {
        // An old owner may clean up its exact VM, but cannot write deployment state.
        if (!config.state.signal.aborted) throw error;
      }
    };
    if (!row.sandbox_id) {
      await recordState('unknown');
      return false;
    }
    await recordState('cleanup');
    try {
      const vm = await abortable(
        sdk.connect(row.sandbox_id, connection(row.environment_id)),
        AbortSignal.timeout(15_000),
      );
      if (vm.status !== 'DESTROYED') {
        await abortable(vm.destroy(), AbortSignal.timeout(15_000));
        const after = await abortable(
          sdk.connect(row.sandbox_id, connection(row.environment_id)),
          AbortSignal.timeout(15_000),
        );
        if (after.status !== 'DESTROYED') return false;
      }
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) return false;
    }
    await recordState('complete');
    return true;
  }

  async function reconcile() {
    if (closed || !configured || active) return;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      // Never resume commands: even a failed response may have produced an external effect.
      for (const row of await pending()) await destroy(row);
    })();
    try {
      await reconciling;
    } finally {
      reconciling = undefined;
    }
  }

  async function perform(script: string | undefined, signal?: AbortSignal) {
    const runId = randomUUID();
    const deadline = Date.now() + DEADLINE_MS;
    const record: Run = {
      id: runId,
      environment_id: environmentId,
      sandbox_id: null,
      state: 'creating',
      deadline,
    };
    const bound = AbortSignal.any([
      controller?.signal || AbortSignal.abort(),
      AbortSignal.timeout(DEADLINE_MS),
      config.state.signal,
      ...(signal ? [signal] : []),
    ]);
    bound.throwIfAborted();
    await db.run(
      'INSERT INTO rove_sandbox_run (id, environment_id, state, deadline, created_at) VALUES ($1, $2, $3, $4, $5)',
      [runId, environmentId, 'creating', deadline, Date.now()],
    );
    let vm: Instance | undefined;
    let command: Command | undefined;
    let failure: unknown;
    let output = '';
    let dispatched = false;
    try {
      await config.state.assertOwned();
      bound.throwIfAborted();
      // The SDK uses the abort-aware fetch for creation and each readiness poll.
      dispatched = true;
      vm = await sdk.create({
        ...connection(environmentId, bound, record),
        networkIsolation: 'ISOLATED',
        idleTimeoutMinutes: 1,
        env: { ROVE_SMOKE_RUN_ID: runId },
      });
      record.sandbox_id = vm.id;
      await db.run(
        "UPDATE rove_sandbox_run SET sandbox_id = $1, state = 'cleanup' WHERE id = $2",
        [vm.id, runId],
      );
      if (vm.networkIsolation !== 'ISOLATED')
        throw new Error('Unexpected network mode.');
      if (script) {
        await abortable(vm.files.write('/tmp/rove-runner.sh', script), bound);
      } else {
        await abortable(vm.files.write('/tmp/rove-smoke.txt', MARKER), bound);
        const content = await abortable(
          vm.files.read('/tmp/rove-smoke.txt', 'text', { length: 128 }),
          bound,
        );
        if (content !== MARKER) throw new Error('Unexpected file result.');
      }
      let outputBytes = 0;
      const collect = (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        // railway@3.12.0 catches callback errors and closes the stream immediately.
        if (outputBytes > OUTPUT_BYTES)
          throw new HttpError(502, 'Sandbox output exceeded the allowed size.');
      };
      command = vm.exec(script ? SANDBOX_COMMAND : COMMAND, {
        onStdout: collect,
        onStderr: collect,
      });
      const result = await abortable(command, bound);
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.truncated ||
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
          OUTPUT_BYTES ||
        (!script &&
          (result.stdout !== 'rove-sandbox-ok' || result.stderr !== ''))
      )
        throw new HttpError(
          502,
          script
            ? 'Sandbox operation failed or native isolation is unavailable.'
            : 'Sandbox smoke failed.',
        );
      if (script) output = sandboxResult(result.stdout);
      await db.run(
        "UPDATE rove_sandbox_run SET outcome = 'passed' WHERE id = $1",
        [runId],
      );
    } catch (error) {
      failure =
        error instanceof HttpError
          ? error
          : new HttpError(
              502,
              'Sandbox operation failed. Check Railway and pending cleanup before retrying.',
            );
      if (command) void command.kill('KILL').catch(() => {});
    } finally {
      if (!dispatched)
        await db.run(
          "UPDATE rove_sandbox_run SET state = 'complete', outcome = 'cancelled' WHERE id = $1",
          [runId],
        );
      else {
        // A fresh connection has a separate deadline: cancellation must not cancel cleanup.
        if (!(await destroy(record)))
          failure = new HttpError(
            503,
            'Sandbox cleanup is pending. No new sandbox will be created until it is resolved.',
          );
      }
    }
    if (failure) throw failure;
    return { runId, status: 'passed' as const, output };
  }

  async function run(script: string | undefined, signal?: AbortSignal) {
    if (closed) throw new HttpError(503, 'Sandbox service is closed.');
    if (!configured)
      throw new HttpError(
        503,
        'Configure a Railway environment and one explicit credential mode first.',
      );
    // ponytail: one lifecycle operation at a time; use per-invocation leases for multiple core instances.
    if (active || reconciling)
      throw new HttpError(
        409,
        'A sandbox operation or cleanup is already pending.',
      );
    controller = new AbortController();
    active = (async () => {
      await config.state.assertOwned();
      const remaining = await pending();
      if (closed) throw new HttpError(503, 'Sandbox service is closed.');
      config.state.signal.throwIfAborted();
      signal?.throwIfAborted();
      if (remaining.length)
        throw new HttpError(
          409,
          'A sandbox operation or cleanup is already pending.',
        );
      return perform(script, signal);
    })();
    try {
      return await active;
    } finally {
      active = undefined;
      controller = undefined;
    }
  }

  async function smoke(signal?: AbortSignal) {
    const { runId, status } = await run(undefined, signal);
    return { runId, status };
  }

  async function execute(input: SandboxInput, signal: AbortSignal) {
    const script = sandboxRunner(input);
    return (await run(script, signal)).output;
  }

  async function close() {
    if (closing) return closing;
    closed = true;
    controller?.abort();
    closing = Promise.allSettled([active, reconciling]).then(() => {});
    return closing;
  }

  return { status, reconcile, smoke, execute, close };
}
