import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { HttpError } from './auth.js';
import type { Config } from './config.js';

const LEASE_MS = 30_000;
const COMMAND_MS = 5_000;
const release = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1]) end return 0`;

export class RuntimeBusyError extends HttpError {}

export interface TurnMetadata {
  kind:
    | 'message'
    | 'action'
    | 'approval'
    | 'settings'
    | 'retention'
    | 'archive';
  conversation?: string;
  scope?: string;
  requestId?: string;
}

export type RuntimeState = Awaited<ReturnType<typeof createRuntimeState>>;

/** One active core owns recovery and workers; Redis is required, never optional. */
export async function createRuntimeState(config: Config) {
  const client = createClient({
    url: config.redisURL,
    socket: { connectTimeout: COMMAND_MS, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  const controller = new AbortController();
  const ownerKey = `${config.redisPrefix}:owner`;
  const turnKey = `${config.redisPrefix}:turn`;
  const token = randomUUID();
  let turn: string | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;

  function lost() {
    controller.abort(
      new HttpError(503, 'Runtime ownership was lost. Restart Rove.'),
    );
    if (timer) clearInterval(timer);
  }
  client.on('error', lost);

  async function command<T>(pending: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            lost();
            if (client.isOpen) client.destroy();
            reject(new HttpError(503, 'Redis is unavailable. Restart Rove.'));
          }, COMMAND_MS);
          timeout.unref();
        }),
      ]);
    } catch {
      lost();
      throw new HttpError(503, 'Redis is unavailable. Restart Rove.');
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  try {
    await command(client.connect());
    const acquired = await command(
      client.set(ownerKey, token, { NX: true, PX: LEASE_MS }),
    );
    if (!acquired)
      throw new HttpError(
        503,
        'Another Rove core owns this deployment. Stop it before starting another.',
      );
    // The previous owner's turn is disposable; durable run and inbox truth stays in PostgreSQL.
    await command(client.del(turnKey));
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  }

  async function assertOwned() {
    if (closed || controller.signal.aborted)
      throw new HttpError(
        503,
        'Runtime ownership is unavailable. Restart Rove.',
      );
    const owned = await command(
      client.eval(
        `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      if ARGV[3] ~= '' then
        if redis.call('GET', KEYS[2]) ~= ARGV[3] then return 0 end
        redis.call('PEXPIRE', KEYS[2], ARGV[2])
      end
      return 1`,
        {
          keys: [ownerKey, turnKey],
          arguments: [token, String(LEASE_MS), turn ?? ''],
        },
      ),
    );
    if (owned !== 1) {
      lost();
      throw new HttpError(503, 'Runtime ownership was lost. Restart Rove.');
    }
  }

  timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void assertOwned()
      .catch(lost)
      .finally(() => {
        checking = false;
      });
  }, LEASE_MS / 3);
  timer.unref();

  return {
    signal: controller.signal,
    assertOwned,
    health: assertOwned,
    async incrementWindow(key: string, windowMs: number) {
      await assertOwned();
      return Number(
        await command(
          client.eval(
            `
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
        return count`,
            {
              keys: [`${config.redisPrefix}:limit:${key}`],
              arguments: [String(windowMs)],
            },
          ),
        ),
      );
    },
    async withTurn<T>(
      metadata: TurnMetadata,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      await assertOwned();
      const value = JSON.stringify({
        ...metadata,
        owner: token,
        id: randomUUID(),
        startedAt: Date.now(),
      });
      const acquired = await command(
        client.eval(
          `
        if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
        if redis.call('SET', KEYS[2], ARGV[2], 'NX', 'PX', ARGV[3]) then return 1 end
        return 0`,
          {
            keys: [ownerKey, turnKey],
            arguments: [token, value, String(LEASE_MS)],
          },
        ),
      );
      if (acquired === -1) {
        lost();
        throw new HttpError(503, 'Runtime ownership was lost. Restart Rove.');
      }
      if (acquired !== 1)
        throw new RuntimeBusyError(
          409,
          'Rove is busy replying. Wait a moment and try again.',
        );
      turn = value;
      try {
        return await action(controller.signal);
      } finally {
        turn = undefined;
        if (!controller.signal.aborted)
          await command(
            client.eval(release, { keys: [turnKey], arguments: [value] }),
          );
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      controller.abort();
      try {
        if (client.isOpen)
          await command(
            client.eval(release, { keys: [ownerKey], arguments: [token] }),
          );
      } finally {
        if (client.isOpen) client.destroy();
      }
    },
  };
}
