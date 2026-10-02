import { HttpError } from './auth.js';

export type SandboxInput = {
  source: string;
  operation: string;
  args: Record<string, unknown>;
  settings: Record<string, string | boolean>;
};

export const SANDBOX_OUTPUT_BYTES = 16_384;
export const SANDBOX_COMMAND =
  '/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /bin/sh /tmp/rove-runner.sh';

/** Only serializes data. This process never imports or evaluates plugin source. */
export function sandboxRunner(input: SandboxInput) {
  let payload: string;
  try {
    if (
      typeof input.source !== 'string' ||
      !input.source.length ||
      Buffer.byteLength(input.source) > 32_000 ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.operation) ||
      !input.args ||
      typeof input.args !== 'object' ||
      Array.isArray(input.args) ||
      !input.settings ||
      typeof input.settings !== 'object' ||
      Array.isArray(input.settings) ||
      Object.values(input.settings).some(
        (value) => typeof value !== 'string' && typeof value !== 'boolean',
      )
    )
      throw new Error('Invalid input');
    payload = JSON.stringify({
      source: input.source,
      operation: input.operation,
      args: input.args,
      settings: input.settings,
    });
    if (Buffer.byteLength(payload) > 65_536) throw new Error('Oversized input');
  } catch {
    throw new HttpError(400, 'Invalid or oversized sandbox operation.');
  }
  const encoded = Buffer.from(payload).toString('base64');
  // Every invocation checks the guest's capabilities before importing downloaded
  // code. Missing native isolation is a hard failure, never a host fallback.
  return String.raw`#!/bin/sh
set -eu
umask 022
fail() { printf 'rove-runner-failed: %s\n' "$1" >&2; exit 1; }
test "$(uname -s)" = Linux || fail linux-required
test "$(id -u)" = 0 || fail root-required
for tool in node cc unshare setpriv timeout mount chroot realpath mktemp ldd cp awk readlink grep dirname wc; do
  command -v "$tool" >/dev/null || fail "missing-$tool"
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || fail node-22-required
node_bin=$(realpath "$(command -v node)")
setpriv_bin=$(realpath "$(command -v setpriv)")
test -w /sys/fs/cgroup/cgroup.subtree_control || fail writable-cgroup-v2-required
for controller in cpu memory pids; do
  case " $(cat /sys/fs/cgroup/cgroup.controllers) " in
    *" $controller "*) ;;
    *) fail "missing-cgroup-$controller" ;;
  esac
done
work=$(mktemp -d /tmp/rove-execution.XXXXXXXX)
cg=/sys/fs/cgroup/rove-execution-$$
cleanup() {
  if test -e "$cg/cgroup.kill"; then printf 1 > "$cg/cgroup.kill" || :; fi
  rmdir "$cg" 2>/dev/null || :
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
printf '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control || fail enable-cgroup-controllers
mkdir "$cg"
test -w "$cg/cgroup.kill" || fail cgroup-kill-required
printf '50000 100000' > "$cg/cpu.max"
printf 268435456 > "$cg/memory.max"
printf 0 > "$cg/memory.swap.max"
printf 32 > "$cg/pids.max"
test "$(cat "$cg/cpu.max")" = '50000 100000' || fail cpu-limit-readback
test "$(cat "$cg/memory.max")" = 268435456 || fail memory-limit-readback
test "$(cat "$cg/memory.swap.max")" = 0 || fail swap-limit-readback
test "$(cat "$cg/pids.max")" = 32 || fail pids-limit-readback
root=$work/root
mkdir -p "$root/runtime" "$root/dev" "$root/proc" "$root/tmp" "$root/app"
chmod 755 "$work" "$root"
for device in null zero random urandom; do : > "$root/dev/$device"; done
# Copy only two trusted executables and their dynamic libraries, never /usr or
# the sandbox filesystem. All paths come from the base image, not plugin data.
copy_runtime() {
  binary=$1
  destination=$2
  cp "$binary" "$root/runtime/$destination"
  ldd "$binary" > "$work/libraries" || fail dynamic-runtime-required
  if grep -q 'not found' "$work/libraries"; then fail missing-runtime-library; fi
  awk '$2 == "=>" && substr($3, 1, 1) == "/" { print $3 } substr($1, 1, 1) == "/" { print $1 }' "$work/libraries" > "$work/paths"
  while IFS= read -r library; do
    case "$library" in /*) ;; *) fail invalid-runtime-library ;; esac
    mkdir -p "$root$(dirname "$library")"
    cp -L "$library" "$root$library"
  done < "$work/paths"
}
# The network namespace alone does not isolate every address family (notably
# AF_VSOCK). A fixed inherited syscall filter blocks all socket creation and
# io_uring, which could otherwise issue socket operations outside seccomp checks.
cat > "$work/launch.c" <<'ROVE_C'
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define ROVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__) && !defined(__ILP32__)
#define ROVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported sandbox CPU architecture
#endif

static int fail(const char *message) {
  perror(message);
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 2) return 1;
  int input = open("/dev/null", O_RDONLY);
  if (input < 0 || dup2(input, STDIN_FILENO) < 0) return fail("stdin");
  if (syscall(SYS_close_range, 3U, ~0U, 0U) < 0) return fail("close_range");
  struct sock_filter instructions[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, ROVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef __x86_64__
    /* x32 uses the same audit architecture with a different syscall-number bit. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog filter = {
    .len = sizeof(instructions) / sizeof(instructions[0]),
    .filter = instructions,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &filter) < 0)
    return fail("seccomp");
  /* Verify exact syscalls after installing the filter, before Node or source. */
  int pair[2];
  if (syscall(SYS_socket, AF_VSOCK, SOCK_STREAM, 0) != -1 || errno != EPERM)
    return fail("vsock filter");
  if (syscall(SYS_socketpair, AF_UNIX, SOCK_STREAM, 0, pair) != -1 || errno != EPERM)
    return fail("socketpair filter");
  if (syscall(SYS_io_uring_setup, 0, NULL) != -1 || errno != EPERM)
    return fail("io_uring filter");
  execv(argv[1], &argv[1]);
  return fail("exec");
}
ROVE_C
cc -O2 -Wall -Wextra -Werror "$work/launch.c" -o "$work/launch" || fail seccomp-launcher-build
copy_runtime "$node_bin" node
copy_runtime "$setpriv_bin" setpriv
copy_runtime "$work/launch" launch
# Base64 is data, so source containing quotes, substitutions or heredoc markers
# cannot modify this trusted script. The decoder writes files without evaluating.
node - "$root" '${encoded}' <<'ROVE_DECODE'
const fs = require('node:fs');
const input = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
fs.writeFileSync(process.argv[2] + '/app/plugin.mjs', input.source);
delete input.source;
fs.writeFileSync(process.argv[2] + '/app/input.json', JSON.stringify(input));
ROVE_DECODE
outer_net=$(readlink /proc/self/ns/net)
cat > "$root/app/run.mjs" <<'ROVE_NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
assert.equal(process.getuid(), 65534);
assert.equal(process.getgid(), 65534);
assert.ok(process.getgroups().every((gid) => gid === 65534));
const status = fs.readFileSync('/proc/self/status', 'utf8');
for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
  assert.match(status, new RegExp('^' + name + ':\\s+0+$', 'm'));
}
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.match(status, /^Seccomp:\s+2$/m);
assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), process.argv[2]);
assert.throws(() => process.kill(1, 'SIGKILL'), { code: 'EPERM' });
assert.deepEqual(Object.keys(process.env), ['PATH']);
assert.throws(() => fs.readFileSync('/sys/fs/cgroup/cgroup.procs'));
assert.throws(() => fs.writeFileSync('/app/plugin.mjs', 'changed'));
assert.throws(() => fs.writeFileSync('/escape', 'changed'));
const tmp = fs.statfsSync('/tmp');
assert.ok(tmp.blocks * tmp.bsize <= 1_048_576);
fs.writeFileSync('/tmp/rove-check', 'ok');
fs.unlinkSync('/tmp/rove-check');
async function denied(host) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: 9 });
    socket.once('connect', () => { socket.destroy(); reject(Error('network reachable')); });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'EPERM') resolve();
      else reject(error);
    });
    socket.setTimeout(500, () => { socket.destroy(); reject(Error('network check timed out')); });
  });
}
await denied('192.0.2.1');
await denied('2001:db8::1');
// Routine logs share the bounded stderr file; stdout is the result protocol.
console.log = console.info = console.debug = console.warn = console.error;
const input = JSON.parse(fs.readFileSync('/app/input.json', 'utf8'));
const plugin = await import('/app/plugin.mjs');
assert.equal(typeof plugin.run, 'function', 'Plugin must export run');
const value = await plugin.run(input);
const result = JSON.stringify({ result: value === undefined ? null : value });
assert.ok(Buffer.byteLength(result) <= 16_384, 'Operation result exceeds 16 KiB');
process.stdout.write(result);
ROVE_NODE
chmod -R a-w "$root"
cat > "$work/init.sh" <<'ROVE_INIT'
#!/bin/sh
set -eu
root=$1
cg=$2
outer_net=$3
# Retain this root PID 1. Dropping UID in PID 1 clears unshare's parent-death
# signal; forking the unprivileged child keeps that kernel cleanup protection.
printf '%s' "$$" > "$cg/cgroup.procs"
mount --bind "$root" "$root"
mount -o remount,bind,ro "$root"
mount -t tmpfs -o size=1048576,mode=1777,nosuid,nodev,noexec tmpfs "$root/tmp"
mount -t proc -o ro,nosuid,nodev,noexec proc "$root/proc"
for device in null zero random urandom; do
  mount --bind "/dev/$device" "$root/dev/$device"
done
# No working-directory escape or inherited environment reaches the child.
chroot_bin=$(command -v chroot)
ulimit -c 0
ulimit -f 32
ulimit -n 64
env -i PATH=/runtime "$chroot_bin" "$root" /runtime/setpriv \
  --reuid=65534 --regid=65534 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \
  /runtime/launch /runtime/node --max-old-space-size=128 /app/run.mjs "$outer_net" < /dev/null &
wait "$!"
ROVE_INIT
chmod 500 "$work/init.sh"
# timeout stays root and outside the plugin cgroup/namespace. The plugin cannot
# kill its watchdog. PID 1 exit and cgroup.kill cover detached descendants.
set +e
timeout --signal=KILL 15s unshare \
  --net --pid --mount --ipc --uts --fork --kill-child=KILL --mount-proc \
  /bin/sh "$work/init.sh" "$root" "$cg" "$outer_net" \
  > "$work/output" 2> "$work/error"
code=$?
set -e
printf 1 > "$cg/cgroup.kill"
remaining=5
while ! test "$(awk '$1 == "populated" { print $2 }' "$cg/cgroup.events")" = 0; do
  remaining=$((remaining - 1))
  test "$remaining" -gt 0 || fail detached-descendant-survived
  sleep 1
done
test "$code" = 0 || fail "execution-exit-$code"
test "$(wc -c < "$work/output")" -le 16384 || fail output-limit
cat "$work/output"
`;
}

export function sandboxResult(stdout: string) {
  try {
    if (Buffer.byteLength(stdout) > SANDBOX_OUTPUT_BYTES)
      throw new Error('Oversized result');
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !('result' in value)
    )
      throw new Error('Invalid result');
    return typeof value.result === 'string'
      ? value.result
      : JSON.stringify(value.result);
  } catch {
    throw new HttpError(502, 'Sandbox returned an invalid operation result.');
  }
}
