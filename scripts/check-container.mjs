// Isolated Docker smoke test. Uses only disposable local containers and a new volume.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const image = process.argv[2] || 'rove:foundation';
const suffix = randomUUID().slice(0, 8);
const name = `rove-check-${suffix}`;
const drainName = `rove-drain-${suffix}`;
const volume = `rove-check-data-${suffix}`;
const origin = 'http://localhost:3000';
const setupSecret = 'container-test-setup-secret-not-production';
const authSecret = 'container-test-auth-secret-not-production';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
let base;
async function call(path, body, cookie = '') {
  return fetch(base + path, {
    headers: { origin, 'content-type': 'application/json', cookie },
    ...(body === undefined
      ? {}
      : { method: 'POST', body: JSON.stringify(body) }),
  });
}
async function start(setup) {
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::3000',
    '-v',
    `${volume}:/data`,
    '-e',
    `ROVE_URL=${origin}`,
    '-e',
    `BETTER_AUTH_SECRET=${authSecret}`,
    ...(setup ? ['-e', `ROVE_SETUP_SECRET=${setupSecret}`] : []),
    image,
  );
  base = `http://${docker('port', name, '3000/tcp')}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await call('/health')).ok) return;
    } catch {
      /* startup is not ready yet */
    }
    await delay(100);
  }
  throw new Error('Container did not become healthy.');
}
try {
  docker('volume', 'create', volume);
  await start(true);
  const processStatus = docker('exec', name, 'cat', '/proc/1/status');
  assert.match(docker('exec', name, 'cat', '/proc/1/cmdline'), /^node\0/);
  assert.match(processStatus, /Uid:\s+1000\s+1000/);
  const body = {
    setupSecret,
    name: 'Container admin',
    email: 'container@example.com',
    password: 'container-test-password',
  };
  assert.equal((await call('/api/setup', body)).status, 201);
  const login = await call('/api/auth/sign-in/email', body);
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  assert.equal((await call('/api/admin/me', undefined, cookie)).status, 200);
  assert.equal(
    (await call('/api/setup', { data: 'x'.repeat(32769) })).status,
    413,
  );
  assert.equal((await call('/app.js')).status, 200);
  assert.equal((await call('/chat.js')).status, 200);
  for (const [path, type] of [
    ['/brand/icon.svg', 'image/svg+xml'],
    ['/fonts/fredoka-600-latin.woff2', 'font/woff2'],
    ['/fonts/inter-latin.woff2', 'font/woff2'],
  ]) {
    const asset = await call(path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), type);
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.ok(bytes.length > 0);
    if (type === 'font/woff2')
      assert.equal(bytes.toString('ascii', 0, 4), 'wOF2');
  }
  // A disposable OpenAI-compatible server inside the container exercises the image's HTTP path.
  docker(
    'exec',
    '-d',
    name,
    'node',
    '-e',
    `
    require('node:http').createServer(async (req, res) => {
      if (req.method === 'GET') { res.end('ready'); return; }
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({choices:[{message:{content:'Container reply: ' + input.messages.at(-1).content},finish_reason:'stop'}]}));
    }).listen(4141, '127.0.0.1');
  `,
  );
  docker(
    'exec',
    name,
    'node',
    '--input-type=module',
    '-e',
    `
    for (let i = 0; i < 50; i++) {
      try { await fetch('http://127.0.0.1:4141'); process.exit(0); } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    process.exit(1);
  `,
  );
  assert.equal(
    (
      await call(
        '/api/admin/settings',
        {
          baseURL: 'http://127.0.0.1:4141/v1',
          model: 'container-test',
          apiKey: 'dummy-container-key',
          systemPrompt: 'Be concise.',
        },
        cookie,
      )
    ).status,
    200,
  );
  const conversation = await (
    await call('/api/admin/conversations', {}, cookie)
  ).json();
  const sent = await call(
    `/api/admin/conversations/${conversation.id}/messages`,
    {
      content: 'Hello from Docker',
      requestId: randomUUID(),
    },
    cookie,
  );
  assert.equal(sent.status, 200);
  assert.equal(
    (await sent.json()).messages.at(-1).content,
    'Container reply: Hello from Docker',
  );

  docker('stop', '-t', '12', name);
  assert.equal(docker('inspect', '-f', '{{.State.ExitCode}}', name), '0');
  docker('rm', name);
  await start(false);
  assert.deepEqual(await (await call('/api/setup')).json(), {
    required: false,
  });
  assert.equal((await call('/api/admin/me', undefined, cookie)).status, 200);
  assert.equal((await call('/api/setup', body)).status, 409);
  const restored = await (
    await call(`/api/admin/conversations/${conversation.id}`, undefined, cookie)
  ).json();
  assert.equal(
    restored.messages.at(-1).content,
    'Container reply: Hello from Docker',
  );
  assert.equal(
    (await (await call('/api/admin/settings', undefined, cookie)).json())
      .configured,
    true,
  );
  docker('stop', '-t', '12', name);
  docker('rm', name);
  // A real child process needing >2 seconds proves the entrypoint preserves signals.
  docker(
    'run',
    '-d',
    '--name',
    drainName,
    image,
    'node',
    '-e',
    "console.log('ready');setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{console.log('drained');process.exit(0)},4000));",
  );
  for (let i = 0; i < 50 && !docker('logs', drainName).includes('ready'); i++)
    await delay(100);
  docker('stop', '-t', '8', drainName);
  assert.match(docker('logs', drainName), /drained/);
  assert.equal(docker('inspect', '-f', '{{.State.ExitCode}}', drainName), '0');
  console.log(
    'PASS: health, non-root PID 1, admin login, body limit, model reply, saved chat, persistent volume, restart without setup secret, graceful shutdown.',
  );
} finally {
  for (const container of [name, drainName]) {
    try {
      docker('rm', '-f', container);
    } catch {
      /* already removed */
    }
  }
  docker('volume', 'rm', volume);
}
