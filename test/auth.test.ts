import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApplication, MAX_BODY } from '../src/app.js';
import { createIdentity } from '../src/auth.js';
import { readConfig } from '../src/config.js';

const origin = 'https://rove.example';
const setupSecret = 'test-setup-secret-for-local-tests-only-32-chars';
const authSecret = 'test-auth-secret-for-local-tests-only-32-chars';
const account = {
  name: 'Example admin',
  email: 'admin@example.com',
  password: 'a-long-test-password',
  setupSecret,
};

function request(
  path: string,
  body?: unknown,
  cookie = '',
  requestOrigin = origin,
) {
  return new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      'content-type': 'application/json',
      cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

test('protected setup, administrator authorization, recovery, sign-out and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rove-auth-'));
  const config = {
    baseURL: origin,
    authSecret,
    setupSecret,
    databasePath: join(dir, 'rove.sqlite'),
  };
  let app = await createApplication(config);
  try {
    assert.equal((await app.fetch(request('/health'))).status, 200);
    assert.deepEqual(await (await app.fetch(request('/api/setup'))).json(), {
      required: true,
    });
    assert.equal((await app.fetch(request('/api/admin/me'))).status, 401);
    assert.equal(
      (
        await app.fetch(
          request('/api/setup', account, '', 'https://attacker.example'),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.fetch(
          request('/api/setup', { ...account, setupSecret: 'wrong' }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await app.fetch(
          request('/api/setup', { ...account, password: 'short' }),
        )
      ).status,
      400,
    );
    assert.equal(
      (await app.fetch(request('/api/auth/sign-up/email', account))).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(
          request('/api/setup', { ...account, email: 'admin@example.c' }),
        )
      ).status,
      400,
    );
    const responses = await Promise.all([
      app.fetch(request('/api/setup', account)),
      app.fetch(request('/api/setup', account)),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    const created = responses.find((r) => r.status === 201);
    assert.ok(created);
    const { recoveryKey } = await created.json();
    assert.match(recoveryKey, /^[a-f0-9]{64}$/);
    assert.equal((await app.fetch(request('/api/setup', account))).status, 409);
    assert.equal(
      (
        await app.fetch(
          request('/api/auth/sign-in/email', {
            ...account,
            password: 'incorrect',
          }),
        )
      ).status,
      401,
    );
    const signedIn = await app.fetch(
      request('/api/auth/sign-in/email', account),
    );
    assert.equal(signedIn.status, 200);
    const setCookie = signedIn.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = cookies(signedIn);
    assert.deepEqual(
      await (
        await app.fetch(request('/api/admin/me', undefined, cookie))
      ).json(),
      { name: account.name, email: account.email, role: 'admin' },
    );
    const db = new DatabaseSync(config.databasePath);
    const stored = db.prepare('SELECT password FROM account').get();
    assert.notEqual(stored?.password, account.password);
    assert.notEqual(
      db.prepare('SELECT recovery_hash FROM rove_admin').get()?.recovery_hash,
      recoveryKey,
    );
    // A valid session alone cannot grant administration to a different user.
    const outsider = randomUUID();
    db.prepare(
      'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,0,?,?)',
    ).run(outsider, 'Other user', 'other@example.com', Date.now(), Date.now());
    db.prepare('UPDATE session SET userId = ?').run(outsider);
    assert.equal(
      (await app.fetch(request('/api/admin/me', undefined, cookie))).status,
      403,
    );
    db.prepare(
      'UPDATE session SET userId = (SELECT user_id FROM rove_admin)',
    ).run();
    db.close();
    await app.close();
    app = await createApplication({ ...config, setupSecret: undefined });
    assert.deepEqual(await (await app.fetch(request('/api/setup'))).json(), {
      required: false,
    });
    assert.equal(
      (await app.fetch(request('/api/admin/me', undefined, cookie))).status,
      200,
    );
    assert.equal(
      (
        await app.fetch(
          request('/api/recover', {
            recoveryKey: setupSecret,
            password: 'new-long-test-password',
          }),
        )
      ).status,
      401,
    );
    const reset = await app.fetch(
      request('/api/recover', {
        recoveryKey,
        password: 'new-long-test-password',
      }),
    );
    assert.equal(reset.status, 200);
    const replacement = await reset.json();
    assert.notEqual(replacement.recoveryKey, recoveryKey);
    assert.equal(
      (await app.fetch(request('/api/admin/me', undefined, cookie))).status,
      401,
    );
    assert.equal(
      (
        await app.fetch(
          request('/api/recover', {
            recoveryKey,
            password: 'yet-another-password',
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (await app.fetch(request('/api/auth/sign-in/email', account))).status,
      401,
    );
    const secondLogin = await app.fetch(
      request('/api/auth/sign-in/email', {
        email: account.email,
        password: 'new-long-test-password',
      }),
    );
    assert.equal(secondLogin.status, 200);
    const secondCookie = cookies(secondLogin);
    assert.equal(
      (await app.fetch(request('/api/auth/sign-out', {}, secondCookie))).status,
      200,
    );
    assert.equal(
      (await app.fetch(request('/api/admin/me', undefined, secondCookie)))
        .status,
      401,
    );
    const response = await app.fetch(request('/'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(
      response.headers.get('content-security-policy') ?? '',
      /frame-ancestors 'none'/,
    );
    assert.match(
      response.headers.get('strict-transport-security') ?? '',
      /max-age=/,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed input and persistent rate limits cannot be bypassed with proxy headers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rove-limit-'));
  const config = {
    baseURL: origin,
    authSecret,
    setupSecret,
    databasePath: join(dir, 'rove.sqlite'),
  };
  let app = await createApplication(config);
  try {
    assert.equal(
      (await app.fetch(request('/api/setup', 'x'.repeat(MAX_BODY + 1)))).status,
      413,
    );
    assert.equal((await app.fetch(request('/api/setup', []))).status, 400);
    const missingOrigin = request('/api/setup', account);
    missingOrigin.headers.delete('origin');
    assert.equal((await app.fetch(missingOrigin)).status, 403);
    const malformed = new Request(`${origin}/api/setup`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal((await app.fetch(malformed)).status, 400);
    for (let i = 0; i < 10; i++) {
      const attempt = request('/api/setup', {
        ...account,
        setupSecret: 'wrong',
      });
      attempt.headers.set('x-forwarded-for', `192.0.2.${i}`);
      assert.equal((await app.fetch(attempt)).status, 401);
    }
    await app.close();
    app = await createApplication(config);
    assert.equal((await app.fetch(request('/api/setup', account))).status, 429);
    assert.equal(
      (await app.fetch(request('/api/auth/link-social', {}))).status,
      404,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deployment config fails closed', () => {
  assert.throws(() => readConfig({}), /ROVE_URL/);
  assert.throws(
    () =>
      readConfig({
        ROVE_URL: 'http://public.example',
        BETTER_AUTH_SECRET: authSecret,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readConfig({
        ROVE_URL: origin,
        BETTER_AUTH_SECRET: authSecret,
        ROVE_SETUP_SECRET: authSecret,
      }),
    /separate/,
  );
  assert.equal(
    readConfig({
      ROVE_URL: 'http://localhost:3000',
      BETTER_AUTH_SECRET: authSecret,
    }).baseURL,
    'http://localhost:3000',
  );
  assert.deepEqual(
    readConfig({
      ROVE_URL: origin,
      ROVE_SETUP_SECRET: setupSecret,
      ROVE_DATABASE_PATH: '/data/chosen.sqlite',
      BETTER_AUTH_SECRET: authSecret,
    }),
    {
      baseURL: origin,
      setupSecret,
      databasePath: '/data/chosen.sqlite',
      authSecret,
    },
  );
  assert.equal(
    readConfig({ ROVE_URL: origin, BETTER_AUTH_SECRET: authSecret })
      .databasePath,
    './data/rove.sqlite',
  );
});

// Pause real password verification to make the reset/login race deterministic.
test('recovery rejects a login already checking the previous password', async () => {
  const identity = await createIdentity({
    baseURL: origin,
    authSecret,
    setupSecret,
    databasePath: ':memory:',
  });
  try {
    const { recoveryKey } = await identity.bootstrap(account);
    const context = await identity.auth.$context;
    const verify = context.password.verify;
    let announceVerified!: () => void;
    const verified = new Promise<void>((resolve) => {
      announceVerified = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.password.verify = async (value) => {
      const result = await verify(value);
      announceVerified();
      await held;
      return result;
    };
    const login = identity.signIn(request('/api/auth/sign-in/email', account));
    await verified;
    await identity.recover({
      recoveryKey,
      password: 'a-different-new-password',
    });
    release();
    await assert.rejects(login, /credentials changed/);
    context.password.verify = verify;
    const fresh = await identity.signIn(
      request('/api/auth/sign-in/email', {
        email: account.email,
        password: 'a-different-new-password',
      }),
    );
    assert.equal(fresh.status, 200);
    assert.equal(
      (
        await identity.requireAdmin(
          request('/api/admin/me', undefined, cookies(fresh)),
        )
      ).role,
      'admin',
    );
  } finally {
    identity.close();
  }
});
