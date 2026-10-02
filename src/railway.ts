import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type ConnectOptions,
  type CreateOptions,
  type ExecOptions,
  type ExecResult,
  Sandbox,
  SandboxNotFoundError,
} from 'railway';
import { HttpError } from './auth.js';
import type { Config } from './config.js';

const DEADLINE_MS = 120_000;
const OUTPUT_BYTES = 16_384;
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

/** Internal lifecycle smoke only. Downloaded executable plugins are not admitted. */
export function createRailwayRuntime(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  sdk: Sdk = Sandbox,
  fetchImplementation: typeof fetch = fetch,
) {
  const db = new DatabaseSync(config.databasePath);
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rove_sandbox_run (
        id TEXT PRIMARY KEY, environment_id TEXT NOT NULL,
        sandbox_id TEXT, state TEXT NOT NULL, deadline INTEGER NOT NULL,
        created_at INTEGER NOT NULL, outcome TEXT NOT NULL DEFAULT 'uncertain'
      )`);
  } catch (error) {
    db.close();
    throw error;
  }
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
  let active: Promise<{ runId: string; status: 'passed' }> | undefined;
  let controller: AbortController | undefined;
  let reconciling: Promise<void> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function pending() {
    return db
      .prepare(
        "SELECT * FROM rove_sandbox_run WHERE state != 'complete' ORDER BY created_at",
      )
      .all() as Run[];
  }

  function status() {
    return {
      provider: 'railway',
      configured,
      environmentId: environmentId || null,
      authType: configured ? authType : null,
      setupNeeded: !configured,
      verification: 'required',
      executablePlugins: false,
      network: 'isolated-private-network-with-public-internet',
      limitations: [
        'Executable plugins remain unavailable until live containment and lifecycle verification passes.',
        'Public internet is available; destination allowlists and deny-all egress are unsupported.',
        'Project-token authorization, resource ceilings, and crash cleanup need live verification.',
      ],
      pendingCleanup: pending().map((row) => ({
        id: row.id,
        environmentId: row.environment_id,
        sandboxId: row.sandbox_id,
        state: row.state,
        deadline: row.deadline,
      })),
    };
  }

  function connection(
    environment: string,
    signal?: AbortSignal,
    recordId?: string,
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
        const response = await fetchImplementation(input, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.any(signals),
        });
        // Persist identity before the SDK's readiness polling, which can fail after creation.
        if (
          recordId &&
          typeof init?.body === 'string' &&
          init.body.includes('sandboxCreate')
        ) {
          const body = (await response.clone().json()) as {
            data?: { sandboxCreate?: { id?: unknown } };
          };
          const id = body.data?.sandboxCreate?.id;
          if (typeof id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(id)) {
            db.prepare(
              'UPDATE rove_sandbox_run SET sandbox_id = ?, state = ? WHERE id = ?',
            ).run(id, 'cleanup', recordId);
          }
        }
        return response;
      },
    };
  }

  async function destroy(row: Run) {
    if (!row.sandbox_id) {
      db.prepare(
        "UPDATE rove_sandbox_run SET state = 'unknown' WHERE id = ?",
      ).run(row.id);
      return false;
    }
    db.prepare(
      "UPDATE rove_sandbox_run SET state = 'cleanup' WHERE id = ?",
    ).run(row.id);
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
    db.prepare(
      "UPDATE rove_sandbox_run SET state = 'complete' WHERE id = ?",
    ).run(row.id);
    return true;
  }

  async function reconcile() {
    if (closed || !configured || active) return;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      // Never resume commands: even a failed response may have produced an external effect.
      for (const row of pending()) await destroy(row);
    })();
    try {
      await reconciling;
    } finally {
      reconciling = undefined;
    }
  }

  async function perform(signal?: AbortSignal) {
    const runId = randomUUID();
    const deadline = Date.now() + DEADLINE_MS;
    const bound = AbortSignal.any([
      controller?.signal || AbortSignal.abort(),
      AbortSignal.timeout(DEADLINE_MS),
      ...(signal ? [signal] : []),
    ]);
    bound.throwIfAborted();
    db.prepare(
      'INSERT INTO rove_sandbox_run (id, environment_id, state, deadline, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(runId, environmentId, 'creating', deadline, Date.now());
    let vm: Instance | undefined;
    let command: Command | undefined;
    let failure: unknown;
    try {
      // The SDK uses the abort-aware fetch for creation and each readiness poll.
      vm = await sdk.create({
        ...connection(environmentId, bound, runId),
        networkIsolation: 'ISOLATED',
        idleTimeoutMinutes: 1,
        env: { ROVE_SMOKE_RUN_ID: runId },
      });
      db.prepare(
        "UPDATE rove_sandbox_run SET sandbox_id = ?, state = 'cleanup' WHERE id = ?",
      ).run(vm.id, runId);
      if (vm.networkIsolation !== 'ISOLATED')
        throw new Error('Unexpected network mode.');
      await abortable(vm.files.write('/tmp/rove-smoke.txt', MARKER), bound);
      const content = await abortable(
        vm.files.read('/tmp/rove-smoke.txt', 'text', { length: 128 }),
        bound,
      );
      if (content !== MARKER) throw new Error('Unexpected file result.');
      let outputBytes = 0;
      const collect = (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        // railway@3.12.0 catches callback errors and closes the stream immediately.
        if (outputBytes > OUTPUT_BYTES)
          throw new HttpError(502, 'Sandbox output exceeded the allowed size.');
      };
      command = vm.exec(COMMAND, { onStdout: collect, onStderr: collect });
      const result = await abortable(command, bound);
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.truncated ||
        result.stdout !== 'rove-sandbox-ok' ||
        result.stderr !== ''
      )
        throw new Error('Unexpected command result.');
      db.prepare(
        "UPDATE rove_sandbox_run SET outcome = 'passed' WHERE id = ?",
      ).run(runId);
    } catch (error) {
      failure =
        error instanceof HttpError
          ? error
          : new HttpError(
              502,
              'Sandbox smoke failed. Check Railway and pending cleanup before retrying.',
            );
      if (command) void command.kill('KILL').catch(() => {});
    } finally {
      const row = db
        .prepare('SELECT * FROM rove_sandbox_run WHERE id = ?')
        .get(runId) as Run;
      // A fresh connection has a separate deadline: cancellation must not cancel cleanup.
      if (!(await destroy(row)))
        failure = new HttpError(
          503,
          'Sandbox cleanup is pending. No new sandbox will be created until it is resolved.',
        );
    }
    if (failure) throw failure;
    return { runId, status: 'passed' as const };
  }

  async function smoke(signal?: AbortSignal) {
    if (closed) throw new HttpError(503, 'Sandbox service is closed.');
    if (!configured)
      throw new HttpError(
        503,
        'Configure a Railway environment and one explicit credential mode first.',
      );
    // ponytail: one lifecycle operation at a time; use per-invocation leases for multiple core instances.
    if (active || reconciling || pending().length)
      throw new HttpError(
        409,
        'A sandbox operation or cleanup is already pending.',
      );
    controller = new AbortController();
    active = perform(signal);
    try {
      return await active;
    } finally {
      active = undefined;
      controller = undefined;
    }
  }

  async function close() {
    if (closing) return closing;
    closed = true;
    controller?.abort();
    closing = Promise.allSettled([active, reconciling]).then(() => db.close());
    return closing;
  }

  return { status, reconcile, smoke, close };
}
