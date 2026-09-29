import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { hashPassword } from 'better-auth/crypto';
import { getMigrations } from 'better-auth/db/migration';
import { email as emailSchema } from 'zod';
import type { Config } from './config.js';

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

export async function createIdentity(config: Config) {
  if (config.databasePath !== ':memory:')
    mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.databasePath);
  db.exec(
    'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
  );
  const options = {
    appName: 'Rove',
    baseURL: config.baseURL,
    secret: config.authSecret,
    trustedOrigins: [config.baseURL],
    database: db,
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
  try {
    await (await getMigrations(options)).runMigrations();
    db.exec(`
      CREATE TABLE IF NOT EXISTS rove_admin (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE RESTRICT,
        recovery_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rove_attempts (
        action TEXT PRIMARY KEY, starts_at INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
    `);
    if (!hasAdmin() && !config.setupSecret)
      throw new Error(
        'ROVE_SETUP_SECRET is required until an administrator has been created.',
      );
  } catch (error) {
    db.close();
    throw error;
  }

  const auth = betterAuth(options);
  await (await auth.$context).checkSchema?.();

  function hasAdmin(): boolean {
    return Boolean(db.prepare('SELECT 1 FROM rove_admin').get());
  }
  function transaction<T>(action: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function limit(action: string): void {
    const now = Date.now();
    // ponytail: deployment-wide limits suit one admin; use trusted-client buckets before multi-user support.
    const row = db
      .prepare(`INSERT INTO rove_attempts VALUES (?, ?, 1)
      ON CONFLICT(action) DO UPDATE SET
        attempts = CASE WHEN starts_at <= ? THEN 1 ELSE attempts + 1 END,
        starts_at = CASE WHEN starts_at <= ? THEN excluded.starts_at ELSE starts_at END
      RETURNING attempts`)
      .get(action, now, now - 60_000, now - 60_000);
    if (Number(row?.attempts) > 10)
      throw new HttpError(
        429,
        'Too many attempts. Wait one minute and try again.',
      );
  }
  async function bootstrap(body: Record<string, unknown>) {
    if (hasAdmin())
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
    const now = Date.now();
    // Keep the Better Auth credential and singleton binding atomic, including across processes.
    // These columns are covered by integration tests against the pinned Better Auth version.
    transaction(() => {
      if (hasAdmin())
        throw new HttpError(
          409,
          'Setup is already complete. Sign in to continue.',
        );
      db.prepare(
        'INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 0, ?, ?)',
      ).run(userId, name, email, now, now);
      db.prepare(
        'INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(randomUUID(), userId, 'credential', userId, password, now, now);
      db.prepare('INSERT INTO rove_admin VALUES (1, ?, ?)').run(
        userId,
        digest(recoveryKey).toString('hex'),
      );
    });
    return { recoveryKey };
  }
  async function recover(body: Record<string, unknown>) {
    const recoveryKey = textField(body, 'recoveryKey', 1, 1024);
    const recoveryHash = digest(recoveryKey).toString('hex');
    if (
      !db
        .prepare('SELECT 1 FROM rove_admin WHERE recovery_hash = ?')
        .get(recoveryHash)
    ) {
      throw new HttpError(
        401,
        'The recovery key is incorrect or has already been used.',
      );
    }
    const password = await hashPassword(textField(body, 'password', 12, 128));
    const nextKey = randomBytes(32).toString('hex');
    transaction(() => {
      const admin = db
        .prepare('SELECT user_id FROM rove_admin WHERE recovery_hash = ?')
        .get(recoveryHash);
      if (!admin || typeof admin.user_id !== 'string')
        throw new HttpError(401, 'The recovery key has already been used.');
      db.prepare(
        "UPDATE account SET password = ?, updatedAt = ? WHERE userId = ? AND providerId = 'credential'",
      ).run(password, Date.now(), admin.user_id);
      db.prepare('DELETE FROM session WHERE userId = ?').run(admin.user_id);
      db.prepare(
        'UPDATE rove_admin SET recovery_hash = ? WHERE singleton = 1',
      ).run(digest(nextKey).toString('hex'));
    });
    return { recoveryKey: nextKey };
  }
  async function signIn(request: Request): Promise<Response> {
    const generation = db
      .prepare('SELECT recovery_hash FROM rove_admin')
      .get()?.recovery_hash;
    const response = await auth.handler(request);
    if (!response.ok) return response;
    const payload: unknown = await response.clone().json();
    // Recovery may have completed while Better Auth checked the previous password.
    // Check after session insertion; delete only this stale login's session.
    if (
      generation !==
      db.prepare('SELECT recovery_hash FROM rove_admin').get()?.recovery_hash
    ) {
      if (
        payload &&
        typeof payload === 'object' &&
        'token' in payload &&
        typeof payload.token === 'string'
      ) {
        db.prepare('DELETE FROM session WHERE token = ?').run(payload.token);
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
      !db
        .prepare('SELECT 1 FROM rove_admin WHERE user_id = ?')
        .get(session.user.id)
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
    close: () => db.close(),
  };
}
