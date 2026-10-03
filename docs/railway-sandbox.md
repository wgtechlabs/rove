# Railway Sandbox support

Rove runs approved JavaScript operations in a fresh Railway sandbox using the
pinned `railway@3.12.0` SDK. The first runtime is **offline**: a plugin receives
JSON arguments and non-secret settings. It receives no credentials, environment
variables, installed packages, or network access. External actions use separately
approved MCP tools. Ordinary chat, skills and MCP use do not require a sandbox.

The implementation is available for configuration; **live Railway execution and
containment have not been verified**. Status reports `verification: not-run`.
`executablePlugins` means the core has a credential and environment configured;
it does not certify the remote guest. Every invocation checks the native controls
before importing plugin code. An incompatible base image fails closed; Rove never
falls back to running downloaded code on the core server.

## Configuration

Set these variables on the **Rove core service**, never on a plugin or sandbox:

| Variable | Purpose |
| --- | --- |
| `RAILWAY_ENVIRONMENT_ID` | Railway supplies the deployment environment ID automatically. |
| `ROVE_SANDBOX_ENVIRONMENT_ID` | Optional explicit override for the sandbox environment. |
| `RAILWAY_API_TOKEN` | Account/workspace token, sent using bearer authentication. |
| `RAILWAY_TOKEN` | Alternative project token, sent using `project-access-token`. Actual sandbox authorization still needs live verification. |
| `ROVE_RAILWAY_AUTH_TYPE` | `bearer` or `project-token`. Required when both tokens exist; otherwise the sole credential determines the mode. |

Supply the narrowest credential whose create, shell, file, lookup and destruction
permissions have been verified in your environment. Rove never retries using a
broader credential. Railway Sandboxes must be enabled for the workspace. A
Railway template cannot grant account permissions on the owner's behalf. Rove
pins the official API and shell endpoints instead of inheriting SDK overrides.

## Operation contract

A native User Plugin supplies a single JavaScript ES module in its reviewed
manifest. Its named export receives the selected operation and JSON data:

```js
export async function run({ operation, args, settings }) {
  if (operation !== 'summarize-count') throw new Error('Unknown operation');
  return { message: `${settings.label}: ${args.count}` };
}
```

The source limit is 32,000 bytes; the complete source, operation, arguments and
settings payload is limited to 64 KiB. A returned string is delivered as text;
other JSON values are serialized. An undefined return becomes `null`. Results
are limited to 16 KiB. Routine console logging is discarded through a bounded
stderr file; writing directly to stdout can invalidate the result protocol.
Local files are ephemeral. No packages are installed and no arbitrary command
endpoint is exposed. Node built-ins are available inside the isolation boundary.

## Per-invocation isolation

The fixed runner requires a Linux root account, Node 22 or newer, standard Linux
namespace tools, a C compiler with Linux headers, kernel seccomp and close-range
support, and writable cgroup v2 delegation for CPU, memory and process limits.
Supported CPU architectures are x86-64 and arm64. Railway's default image must provide these; Rove does not download tools
or loosen controls when they are missing.

Before plugin import, the runner:

1. Creates a private network, PID, mount, IPC and UTS namespace. Railway's
   `ISOLATED` setting blocks its private network but still permits public
   internet; the additional guest network namespace has no external interfaces
   or routes. A trusted C launcher installs an inherited seccomp filter before
   Node starts: all socket/socketpair creation and io_uring setup return EPERM,
   including AF_VSOCK, which a network namespace alone may not isolate. The
   filter rejects other CPU syscall architectures and the x32 compatibility ABI.
   A fixed preflight checks the filter, and Node checks IPv4/IPv6 denial.
2. Builds a read-only chroot containing only Node, the privilege-drop executable,
   the fixed compiled launcher, their dynamic libraries, and the reviewed
   operation files. It does not mount
   `/usr`, the sandbox filesystem, the core filesystem or credentials into the guest.
   The writable temporary directory is a separate 1 MiB filesystem.
3. Starts plugin code as UID/GID 65534, clears supplementary groups and all
   capabilities, and requires `no_new_privs`. The environment contains only
   `PATH`. The launcher replaces stdin with `/dev/null` and closes every inherited
   descriptor above stderr; stdout/stderr are bounded regular output files. The
   root PID 1 remains outside the chroot and cannot be signalled by
   the unprivileged plugin.
4. Reads back cgroup limits of 0.5 CPU, 256 MiB memory, zero swap and 32 processes.
   Node also has a 128 MiB old-space ceiling; file descriptors and output-file
   sizes are bounded. The provider create request additionally requests 1 CPU
   and 2 GB memory, injected into the API request because the pinned SDK omits
   the resource fields from its public options.
5. Uses a 15-second root watchdog outside the plugin cgroup. PID 1 shutdown and
   `cgroup.kill` terminate detached descendants. The runner confirms the cgroup
   is empty before returning output. The core never uses the SDK socket timeout
   alone as evidence that a command stopped.

The watchdog starts before any plugin source is loaded. It is independent of the
core connection, but crash/disconnection behavior still requires verification on
the target platform. A Linux check on another provider cannot prove Railway's
image capabilities or lifecycle behavior.

## Ownership, cleanup and recovery

Rove persists a creation intent in PostgreSQL before contacting Railway and records the sandbox
ID from the create response before readiness polling. A later readiness failure
can therefore still be cleaned up. The VM receives only a non-secret run marker,
never the core process environment. A two-minute core deadline bounds the complete
operation, and output callbacks enforce a 16 KiB combined response limit.

Success is returned only after a separate, bounded connection confirms the VM is
destroyed or absent. An accepted destruction request alone is insufficient. On
restart, Rove destroys recorded owned VMs and never resumes operations or repeats
their effects. Failed cleanup remains visible and blocks new executions. This
version supports one active core per deployment, enforced through Redis ownership.
It does not distribute sandbox execution across replicas.

The SDK can allocate a received output chunk before the core callback sees it;
the callback limit alone is not a process-memory proof. The guest runner bounds
output files before forwarding a result. Provider-side output from failures
outside the runner remains subject to the SDK behavior.

The pinned SDK has no create idempotency key, name or tags. If the entire create
response is lost before Rove records its ID, the outcome remains `unknown`.
Rove neither creates a replacement nor deletes other sandboxes by time guesses.
For a known ID, restore API access and restart to retry cleanup. For an unknown
ID, stop Rove, retain a database backup, and use Railway's console or support to
identify the exact VM from its run marker. Destroy it and verify removal. Only
after ownership and cleanup are confirmed may an operator mark that specific
`rove_sandbox_run` record complete, retaining the recovery outcome.

A core crash may leave a VM awaiting reconciliation even after its guest code has
stopped. Railway's idle timeout is a fallback, not proof of destruction or a hard
billing deadline. Persistent cleanup records must not be silently discarded.

## Verification

Ordinary tests create no cloud resources. They check SDK lifecycle decisions,
actual SDK authentication headers and resource requests, script parsing, input
and output bounds, and fail-closed guards using controlled boundaries. These are
not evidence of a live Railway sandbox run.

An additional regression executes the complete generated runner, including
filesystem denial, a full temporary filesystem, detached children, a runaway
operation and an output flood. Run it only in a **disposable root Linux host**
with writable cgroup v2, namespace capabilities, and a C compiler with Linux
headers, never the application
container or a shared host:

```sh
bun run build
ROVE_NATIVE_SANDBOX_TEST=1 node --test dist/test/sandbox-runner.test.js
```

The test is skipped unless explicitly enabled. It creates only local temporary
files, namespaces and cgroups; it does not provision remote infrastructure. It
must fail when the required controls are unavailable. The dedicated GitHub CI job runs this check on a disposable Ubuntu VM with
read-only repository permissions and no deployment credentials. It does not
create a Railway test deployment.

The internal `runtime.smoke()` remains a fixed API/file/command/cleanup check.
It does not validate the executable boundary and does not change verification
status. Any later live validation must be explicitly authorized because sandbox
creation is billable. It should cover the target image, credential mode, core
termination and lost connections during each lifecycle phase, resource pressure,
network denial, and confirmed cleanup. Record IDs and outcomes without secrets.

## References

- [Railway Sandbox overview](https://docs.railway.com/sandboxes)
- [Railway Sandbox quickstart](https://docs.railway.com/sandboxes/quickstart)
- [Pinned SDK execution implementation](https://github.com/railwayapp/railway-ts-sdk/blob/4504d8aa28861f23466cd3a9e3df03bac8b78227/src/sandbox/exec.ts)
- [Pinned SDK creation and cleanup implementation](https://github.com/railwayapp/railway-ts-sdk/blob/4504d8aa28861f23466cd3a9e3df03bac8b78227/src/sandbox/engine.ts)
