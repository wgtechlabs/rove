import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { hashPassword } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import { email as emailSchema } from 'zod';
import type { RuntimeConfig } from './runtime.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
function matches(value: string, expected: string): boolean {
  return timingSafeEqual(digest(value), digest(expected));
}

export function textField(
  body: Record<string, unknown>,
  name: string,
  min = 1,
  max = 256,
): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, `${name} must contain ${min}–${max} characters.`);
  }
  return value;
}

export async function createIdentity(config: RuntimeConfig) {
  const db = config.db;
  async function requireSessionOwnership() {
    try {
      await config.state.assertOwned();
    } catch {
      throw new APIError('SERVICE_UNAVAILABLE', {
        message: 'Runtime ownership is unavailable. Restart Rove.',
      });
    }
  }
  const options = {
    appName: 'Rove',
    baseURL: config.baseURL,
    secret: config.authSecret,
    trustedOrigins: [config.baseURL],
    database: db.pool,
    databaseHooks: {
      session: {
        create: { before: requireSessionOwnership },
        delete: { before: requireSessionOwnership },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 8,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.baseURL.startsWith('https:'),
      ipAddress: { disableIpTracking: true },
    },
    // All exposed credential routes share a persistent limiter below, independent of proxy headers.
    rateLimit: { enabled: false },
    logger: { level: 'error' },
    telemetry: { enabled: false },
  } satisfies BetterAuthOptions;
  await (await getMigrations(options)).runMigrations();
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_admin (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE RESTRICT,
      recovery_hash TEXT NOT NULL
    );
  `);
  if (!(await hasAdmin()) && !config.setupSecret)
    throw new Error(
      'ROVE_SETUP_SECRET is required until an administrator has been created.',
    );
  const auth = betterAuth(options);
  await (await auth.$context).checkSchema?.();

  async function hasAdmin(): Promise<boolean> {
    return Boolean(await db.get('SELECT 1 FROM rove_admin'));
  }
  async function limit(action: string): Promise<void> {
    // ponytail: deployment-wide limits suit one admin; use trusted-client buckets before multi-user support.
    if ((await config.state.incrementWindow(`auth:${action}`, 60_000)) > 10)
      throw new HttpError(
        429,
        'Too many attempts. Wait one minute and try again.',
      );
  }
  async function bootstrap(body: Record<string, unknown>) {
    if (await hasAdmin())
      throw new HttpError(
        409,
        'Setup is already complete. Sign in to continue.',
      );
    const secret = textField(body, 'setupSecret', 1, 1024);
    if (!config.setupSecret || !matches(secret, config.setupSecret))
      throw new HttpError(401, 'The setup secret is incorrect.');
    const name = textField(body, 'name', 1, 80).trim();
    const email = textField(body, 'email', 3, 254).trim().toLowerCase();
    if (!name || !emailSchema().safeParse(email).success)
      throw new HttpError(400, 'Enter your name and a valid email address.');
    const password = await hashPassword(textField(body, 'password', 12, 128));
    const userId = randomUUID();
    const recoveryKey = randomBytes(32).toString('hex');
    const now = new Date();
    await config.state.assertOwned();
    await db.transaction(async (tx) => {
      await tx.exec('SELECT pg_advisory_xact_lock(728683002)');
      if (await tx.get('SELECT 1 FROM rove_admin'))
        throw new HttpError(
          409,
          'Setup is already complete. Sign in to continue.',
        );
      await tx.run(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1, $2, $3, false, $4, $4)',
        [userId, name, email, now],
      );
      await tx.run(
        'INSERT INTO account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES ($1, $2, $3, $2, $4, $5, $5)',
        [randomUUID(), userId, 'credential', password, now],
      );
      await tx.run('INSERT INTO rove_admin VALUES (1, $1, $2)', [
        userId,
        digest(recoveryKey).toString('hex'),
      ]);
    });
    return { recoveryKey };
  }
  async function recover(body: Record<string, unknown>) {
    const recoveryKey = textField(body, 'recoveryKey', 1, 1024);
    const recoveryHash = digest(recoveryKey).toString('hex');
    if (
      !(await db.get('SELECT 1 FROM rove_admin WHERE recovery_hash = $1', [
        recoveryHash,
      ]))
    )
      throw new HttpError(
        401,
        'The recovery key is incorrect or has already been used.',
      );
    const password = await hashPassword(textField(body, 'password', 12, 128));
    const nextKey = randomBytes(32).toString('hex');
    await config.state.assertOwned();
    await db.transaction(async (tx) => {
      const admin = await tx.get<{ user_id: string }>(
        'SELECT user_id FROM rove_admin WHERE recovery_hash = $1 FOR UPDATE',
        [recoveryHash],
      );
      if (!admin)
        throw new HttpError(401, 'The recovery key has already been used.');
      await tx.run(
        `UPDATE account SET password = $1, "updatedAt" = $2 WHERE "userId" = $3 AND "providerId" = 'credential'`,
        [password, new Date(), admin.user_id],
      );
      await tx.run('DELETE FROM session WHERE "userId" = $1', [admin.user_id]);
      await tx.run(
        'UPDATE rove_admin SET recovery_hash = $1 WHERE singleton = 1',
        [digest(nextKey).toString('hex')],
      );
    });
    return { recoveryKey: nextKey };
  }
  async function signIn(request: Request): Promise<Response> {
    const generation = (await db.get('SELECT recovery_hash FROM rove_admin'))
      ?.recovery_hash;
    const response = await auth.handler(request);
    if (!response.ok) return response;
    const payload: unknown = await response.clone().json();
    // Recovery may have completed while Better Auth checked the previous password.
    // Check after session insertion; delete only this stale login's session.
    if (
      generation !==
      (await db.get('SELECT recovery_hash FROM rove_admin'))?.recovery_hash
    ) {
      if (
        payload &&
        typeof payload === 'object' &&
        'token' in payload &&
        typeof payload.token === 'string'
      ) {
        await db.run('DELETE FROM session WHERE token = $1', [payload.token]);
      }
      throw new HttpError(
        401,
        'Your credentials changed. Sign in again with your new password.',
      );
    }
    return response;
  }
  async function requireAdmin(request: Request) {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new HttpError(401, 'Sign in to continue.');
    if (
      !(await db.get('SELECT 1 FROM rove_admin WHERE user_id = $1', [
        session.user.id,
      ]))
    ) {
      throw new HttpError(403, 'Administrator access is required.');
    }
    return {
      name: session.user.name,
      email: session.user.email,
      role: 'admin' as const,
    };
  }
  return {
    auth,
    hasAdmin,
    bootstrap,
    recover,
    signIn,
    requireAdmin,
    limit,
  };
}
