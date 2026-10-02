import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandboxResult, sandboxRunner } from '../src/sandbox-runner.js';

const input = {
  source: 'export async function run({ args }) { return args; }',
  operation: 'echo',
  args: { message: 'Hello' },
  settings: { enabled: true },
};

test('the generated shell and trusted JavaScript parse, with plugin source kept as data', () => {
  const script = sandboxRunner({
    ...input,
    source: "'\nROVE_DECODE\n$(touch /tmp/rove-unsafe)\n",
  });
  assert.equal(script.includes('touch /tmp/rove-unsafe'), false);
  const shell = spawnSync('/bin/sh', ['-n'], {
    input: script,
    encoding: 'utf8',
  });
  assert.equal(shell.status, 0, shell.stderr);
  for (const marker of ['ROVE_DECODE', 'ROVE_NODE']) {
    const source = script
      .split(`<<'${marker}'\n`)[1]
      ?.split(`\n${marker}\n`)[0];
    assert.ok(source);
    const parsed = spawnSync(
      process.execPath,
      ['--check', '--input-type=module'],
      { input: source, encoding: 'utf8' },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
  }
});

test('unsupported native isolation fails before decoding or loading a plugin', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rove-runner-guard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'uname'), '#!/bin/sh\nprintf Unsupported');
  chmodSync(join(dir, 'uname'), 0o700);
  const rejected = spawnSync('/bin/sh', [], {
    input: sandboxRunner(input),
    env: { PATH: dir },
    encoding: 'utf8',
    timeout: 1_000,
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /rove-runner-failed: linux-required/);
});

test('runtime input and result boundaries reject malformed and oversized data', () => {
  for (const bad of [
    { ...input, source: 'x'.repeat(32_001) },
    { ...input, operation: 'bad; command' },
    { ...input, args: { text: 'x'.repeat(65_536) } },
  ])
    assert.throws(() => sandboxRunner(bad));
  assert.equal(sandboxResult('{"result":"hello"}'), 'hello');
  assert.equal(sandboxResult('{"result":{"ok":true}}'), '{"ok":true}');
  assert.equal(sandboxResult('{"result":null}'), 'null');
  for (const bad of [
    'null',
    '[]',
    '{}',
    '{"result":1,"extra":true}',
    'not JSON',
    JSON.stringify({ result: 'x'.repeat(16_384) }),
  ]) {
    assert.throws(() => sandboxResult(bad));
  }
});

// Explicit opt-in: this needs a disposable root Linux environment with writable
// cgroup v2 delegation and mount/network/PID namespace capabilities, never the
// application container or a shared host. No remote resources are created.
test('native Linux containment handles success, detached children, timeout, and output flood', {
  skip: process.env.ROVE_NATIVE_SANDBOX_TEST !== '1',
  timeout: 90_000,
}, (t) => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid?.(), 0);
  const dir = mkdtempSync(join(tmpdir(), 'rove-native-proof-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sentinel = join(dir, 'outside-secret');
  writeFileSync(sentinel, 'must not reach plugin');
  const run = (source: string) =>
    spawnSync(
      '/usr/bin/env',
      ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', '/bin/sh'],
      {
        input: sandboxRunner({ ...input, source, args: { sentinel } }),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 32_768,
      },
    );
  const success = run(`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { spawn } from 'node:child_process';
      export async function run({ args }) {
        assert.throws(() => fs.readFileSync(args.sentinel));
        assert.throws(() => fs.readFileSync('/proc/1/root' + args.sentinel));
        assert.throws(() => {
          for (let i = 0; i < 300; i++) fs.writeFileSync('/tmp/full-' + i, Buffer.alloc(8192));
        }, { code: 'ENOSPC' });
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          detached: true, stdio: 'ignore', env: {},
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        console.log('bounded diagnostic log');
        return { isolated: true };
      }
    `);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(sandboxResult(success.stdout), '{"isolated":true}');
  // The trusted shell checks cgroup emptiness before reporting success, so this
  // also verifies that the detached child cannot survive a completed call.
  const timeout = run(
    'export async function run() { await new Promise(() => { setInterval(() => {}, 100); }); }',
  );
  assert.equal(timeout.error, undefined);
  assert.notEqual(timeout.status, 0);
  assert.match(timeout.stderr, /rove-runner-failed: execution-exit-/);
  const flood = run(
    'export async function run() { for (;;) process.stdout.write("x".repeat(65536)); }',
  );
  assert.equal(flood.error, undefined);
  assert.notEqual(flood.status, 0);
  assert.ok(Buffer.byteLength(flood.stdout) <= 16_384);
});
