import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApplication, MAX_BODY, requestBodyLimit } from '../src/app.js';
import { createIdentity } from '../src/auth.js';
import { readConfig } from '../src/config.js';
import { createDatabase } from '../src/database.js';
import { createExtensions } from '../src/extensions.js';
import { createPlugins } from '../src/plugins.js';
import { closeRuntime, openRuntime } from '../src/runtime.js';
import { testConfig, testRuntime } from './storage.js';

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

test('protected setup, administrator authorization, recovery, sign-out and restart', async (t) => {
  const config = {
    ...(await testConfig(t)),
    baseURL: origin,
    authSecret,
    setupSecret,
  };
  let app = await createApplication(config);
  try {
    assert.equal((await app.fetch(request('/health'))).status, 200);
    assert.deepEqual(await (await app.fetch(request('/api/setup'))).json(), {
      required: true,
    });
    assert.equal((await app.fetch(request('/api/admin/me'))).status, 401);
    for (const path of [
      '/api/admin/plugins',
      '/api/admin/plugins/contributions',
      `/api/admin/plugins/00000000-0000-4000-8000-000000000001/releases/${'a'.repeat(64)}`,
      '/api/admin/runtime',
      '/api/admin/channels',
      '/api/admin/plugins/00000000-0000-4000-8000-000000000001/channel',
    ])
      assert.equal((await app.fetch(request(path))).status, 401);
    for (const action of [
      'sources',
      'install',
      'configure',
      'activate',
      'deactivate',
    ])
      assert.equal(
        (await app.fetch(request(`/api/admin/plugins/${action}`, {}))).status,
        401,
      );
    assert.equal(
      (
        await app.fetch(
          request(
            '/api/admin/conversations/00000000-0000-4000-8000-000000000001/actions',
            {},
          ),
        )
      ).status,
      401,
    );
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
    for (const path of [
      '/api/admin/plugins',
      '/api/admin/runtime',
      '/api/admin/channels',
    ])
      assert.equal(
        (await app.fetch(request(path, undefined, cookie))).status,
        200,
      );
    assert.equal(
      (
        await app.fetch(
          request(
            '/api/admin/plugins/sources',
            { repo: 'example/company-agent', approved: true },
            cookie,
            'https://attacker.example',
          ),
        )
      ).status,
      403,
    );
    assert.deepEqual(
      await (
        await app.fetch(request('/api/admin/me', undefined, cookie))
      ).json(),
      { name: account.name, email: account.email, role: 'admin' },
    );
    const db = await createDatabase(config.databaseURL);
    const stored = await db.get('SELECT password FROM account');
    assert.notEqual(stored?.password, account.password);
    assert.notEqual(
      (await db.get('SELECT recovery_hash FROM rove_admin'))?.recovery_hash,
      recoveryKey,
    );
    // A valid session alone cannot grant administration to a different user.
    const outsider = randomUUID();
    await db.run(
      'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,$4,$4)',
      [outsider, 'Other user', 'other@example.com', new Date()],
    );
    await db.run('UPDATE session SET "userId" = $1', [outsider]);
    assert.equal(
      (await app.fetch(request('/api/admin/me', undefined, cookie))).status,
      403,
    );
    await db.run(
      'UPDATE session SET "userId" = (SELECT user_id FROM rove_admin)',
    );
    await db.close();
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
  }
});

test('plugin configuration accepts all declared settings and secrets within its own HTTP envelope', async (t) => {
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  t.after(() => app?.close());
  const config = {
    ...(await testConfig(t)),
    baseURL: origin,
    authSecret,
    setupSecret,
  };
  const fixture = await openRuntime(config);
  const fields = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      key: `field-${n}`,
      label: `Field ${n}`,
      required: true,
    }));
  const pkg = {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'large-config',
    name: 'Large configuration',
    version: '1.0.0',
    category: 'agent',
    description: '',
    settings: fields(16).map((field) => ({ ...field, type: 'text' })),
    secrets: fields(8).map((field) => ({
      ...field,
      key: `secret-${field.key}`,
    })),
  };
  const bytes = JSON.stringify(pkg);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const controlledFetch: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.includes('/releases/tags/'))
      return Response.json({
        tag_name: 'v1.0.0',
        draft: false,
        prerelease: false,
        assets: [
          {
            id: 7,
            name: 'rove-plugin.json',
            state: 'uploaded',
            size: Buffer.byteLength(bytes),
            digest: `sha256:${digest}`,
          },
        ],
      });
    if (path.includes('/git/ref/tags/'))
      return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (path.endsWith('/contents/rove-plugin.json'))
      return Response.json({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(bytes).toString('base64'),
      });
    if (path.endsWith('/releases/assets/7')) return new Response(bytes);
    assert.fail(`Unexpected fixture request: ${path}`);
  };
  const extensions = await createExtensions(fixture);
  const plugins = await createPlugins(fixture, extensions, controlledFetch);
  let installation: Awaited<
    ReturnType<typeof plugins.list>
  >['installations'][number];
  try {
    await plugins.saveSource({ repo: 'example/large-config', approved: true });
    const state = await plugins.install({
      repo: 'example/large-config',
      tag: 'v1.0.0',
    });
    assert.ok(state.installations[0]);
    installation = state.installations[0];
  } finally {
    await plugins.close();
    await extensions.close();
    await closeRuntime(fixture);
  }
  app = await createApplication(config);
  assert.equal((await app.fetch(request('/api/setup', account))).status, 201);
  const cookie = cookies(
    await app.fetch(request('/api/auth/sign-in/email', account)),
  );
  // Escaped control characters exercise JSON's six-byte-per-character overhead.
  const value = '\u0001'.repeat(2000);
  const body = {
    id: installation.id,
    revision: installation.revision,
    digest,
    grants: [],
    values: Object.fromEntries(pkg.settings.map((field) => [field.key, value])),
    secrets: Object.fromEntries(
      pkg.secrets.map((field) => [field.key, { source: 'stored', value }]),
    ),
  };
  const path = '/api/admin/plugins/configure';
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > MAX_BODY);
  assert.equal((await app.fetch(request(path, body))).status, 401);
  assert.equal(
    (await app.fetch(request(path, body, cookie, 'https://attacker.example')))
      .status,
    403,
  );
  const result = await app.fetch(request(path, body, cookie));
  assert.equal(result.status, 200, await result.clone().text());
  const saved = await result.json();
  assert.deepEqual(saved.installations[0].values, body.values);
  assert.equal(JSON.stringify(saved).includes('"encrypted"'), false);
  assert.equal(
    (await app.fetch(request('/api/admin/settings', body, cookie))).status,
    413,
  );
  const oversized = request(path, body, cookie);
  assert.equal(
    (
      await app.fetch(
        new Request(oversized.url, {
          method: 'POST',
          headers: oversized.headers,
          body: JSON.stringify(body).padEnd(requestBodyLimit(path) + 1),
        }),
      )
    ).status,
    413,
  );
});

test('malformed input and persistent rate limits cannot be bypassed with proxy headers', async (t) => {
  const config = {
    ...(await testConfig(t)),
    baseURL: origin,
    authSecret,
    setupSecret,
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
  const env = {
    ROVE_URL: origin,
    BETTER_AUTH_SECRET: authSecret,
    DATABASE_URL: 'postgres://localhost/rove',
    REDIS_URL: 'redis://localhost:6379',
  };
  assert.equal(
    readConfig({ ...env, ROVE_URL: 'http://localhost:3000' }).baseURL,
    'http://localhost:3000',
  );
  assert.deepEqual(readConfig({ ...env, ROVE_SETUP_SECRET: setupSecret }), {
    baseURL: origin,
    setupSecret,
    authSecret,
    databaseURL: env.DATABASE_URL,
    redisURL: env.REDIS_URL,
    redisPrefix: 'rove',
  });
  assert.throws(
    () => readConfig({ ...env, DATABASE_URL: undefined }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => readConfig({ ...env, REDIS_URL: undefined }),
    /REDIS_URL/,
  );
  assert.throws(
    () => readConfig({ ...env, DATABASE_URL: 'file:/tmp/db' }),
    /DATABASE_URL/,
  );
  assert.throws(
    () => readConfig({ ...env, ROVE_STATE_KEY_PREFIX: '*' }),
    /ROVE_STATE_KEY_PREFIX/,
  );
});

// Pause real password verification to make the reset/login race deterministic.
test('recovery rejects a login already checking the previous password', async (t) => {
  const identity = await createIdentity({
    ...(await testRuntime(t)),
    baseURL: origin,
    authSecret,
    setupSecret,
  });
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
});

test('login cannot insert a session after runtime ownership is lost during password verification', async (t) => {
  const config = {
    ...(await testRuntime(t)),
    baseURL: origin,
    authSecret,
    setupSecret,
  };
  const identity = await createIdentity(config);
  await identity.bootstrap(account);
  const context = await identity.auth.$context;
  const verify = context.password.verify;
  context.password.verify = async (value) => {
    const result = await verify(value);
    await config.state.close();
    return result;
  };
  const response = await identity.signIn(
    request('/api/auth/sign-in/email', account),
  );
  assert.equal(response.status, 503);
  assert.equal(
    (await config.db.get('SELECT count(*) AS count FROM session'))?.count,
    0,
  );
});

test('sign-out and expired-session cleanup cannot delete after ownership loss during lookup', async (t) => {
  for (const expired of [false, true]) {
    const config = {
      ...(await testRuntime(t)),
      baseURL: origin,
      authSecret,
      setupSecret,
    };
    const identity = await createIdentity(config);
    await identity.bootstrap(account);
    const login = await identity.signIn(
      request('/api/auth/sign-in/email', account),
    );
    assert.equal(login.status, 200);
    if (expired) {
      await config.db.run('UPDATE session SET "expiresAt" = $1', [new Date(0)]);
    }
    const context = await identity.auth.$context;
    const findSession = context.internalAdapter.findSession;
    t.mock.method(
      context.internalAdapter,
      'findSession',
      async (token: string) => {
        const session = await findSession(token);
        await config.state.close();
        return session;
      },
    );
    const response = await identity.auth.handler(
      request(
        expired ? '/api/auth/get-session' : '/api/auth/sign-out',
        expired ? undefined : {},
        cookies(login),
      ),
    );
    // Sign-out deliberately clears the browser cookie even if native deletion fails.
    assert.equal(response.status, expired ? 503 : 200);
    assert.equal(
      (await config.db.get('SELECT count(*) AS count FROM session'))?.count,
      1,
      'An old owner must leave durable sessions for the active core.',
    );
  }
});
