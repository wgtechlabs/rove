# Railway Sandbox support

Rove includes the official `railway@3.12.0` SDK and an internal lifecycle smoke
check. **Downloaded executable plugins are unavailable.** Adding credentials does
not enable them. Ordinary web chat, local skills, and supported remote MCP tools
do not create a sandbox or require a Railway token.

The administrator's sandbox status shows setup requirements, pending cleanup and
`verification: required`. A successful internal smoke does not change that gate.
There is no HTTP endpoint for arbitrary commands or for running this smoke.

## Configuration

Set these variables on the **Rove core service**, never on a plugin or sandbox:

| Variable | Purpose |
| --- | --- |
| `RAILWAY_ENVIRONMENT_ID` | Railway supplies the deployment environment ID automatically. |
| `ROVE_SANDBOX_ENVIRONMENT_ID` | Optional explicit override, useful for an isolated test environment. |
| `RAILWAY_API_TOKEN` | Account/workspace token, sent using bearer authentication. |
| `RAILWAY_TOKEN` | Alternative project token, sent using `project-access-token`. Actual sandbox authorization still needs live verification. |
| `ROVE_RAILWAY_AUTH_TYPE` | `bearer` or `project-token`. Required when both token variables are present; otherwise the sole credential determines the mode. |

Supply the narrowest credential whose create, shell, file, lookup and destruction
permissions have been verified in your environment. Rove never retries using a
broader credential. A template cannot issue account permissions on the owner's
behalf. The integration pins Railway's official API and shell endpoints instead
of inheriting SDK endpoint overrides.

## Implemented boundary

The internal smoke persists a creation intent before contacting Railway. It then:

1. Creates a fresh VM with `networkIsolation: ISOLATED`, a one-minute idle timeout,
   and only a non-secret `ROVE_SMOKE_RUN_ID` marker in its supplied environment.
2. Records the sandbox ID from the create response before the SDK polls for
   readiness. A later readiness failure can therefore still be cleaned up.
3. Writes and reads a fixed small file, then runs a fixed command that checks that
   file and the absence of three core credential variables. No caller supplies
   code, commands, files or environment values.
4. Enforces a two-minute lifecycle deadline and a 16 KiB combined command-output
   limit. Output callbacks reject once the cap is crossed; a failure/cancellation
   also signals `KILL` and destroys the VM. Cleanup has its own bounded connection,
   independent of the cancelled execution connection.
5. Confirms that the VM is destroyed or no longer exists. An accepted destroy
   request alone does not clear the durable cleanup record.

The SDK has already allocated a received output chunk before invoking callbacks;
this cap is not a proof of a hard process-memory ceiling. Its built-in execution
socket timeout is not used as proof that a durable command stopped.

On restart, Rove reconciles recorded sandbox IDs by destroying them. It never
resumes commands or repeats their effects. Failed cleanup stays visible and blocks
another smoke until resolved. This integration supports one core instance per
persistent database; multi-instance execution leases are not implemented.

## Unknown creation and recovery

The pinned SDK has no create idempotency key, name or tags. A unique run marker is
included in the VM environment, but the sandbox inventory does not expose that
marker. If the entire create response is lost before Rove can record its ID, the
outcome remains `unknown`. Rove neither creates a replacement nor deletes other
sandboxes by time-based guesses.

For a known ID, restore API access and restart Rove to retry cleanup. For an
unknown ID, stop Rove, retain the database backup and use the Railway console or
Railway support to identify the exact VM by the run marker. Destroy it and verify
its removal. Do not assume that an empty or partial inventory proves absence.
Only after ownership and cleanup are confirmed may an operator mark that specific
`rove_sandbox_run` record complete, retaining its ID and recovery outcome. If
identity or cleanup cannot be confirmed, retain the unresolved record.

The deadline is persisted for investigation and restart reconciliation. It is
not a provider-side hard deadline: if the core crashes or Railway is unreachable,
idle timeout may not stop an active durable command. Live crash/orphan tests and
an enforceable independent termination policy remain release gates.

## Authorized live smoke

Run only against an environment whose owner has approved temporary billable VM
creation. No cloud smoke is part of the ordinary test suite or application
startup. Build first, provide the normal core configuration plus the Railway
variables above, then invoke the internal service in a Node 24 process:

```js
import { readConfig } from './dist/src/config.js';
import { createRailwayRuntime } from './dist/src/railway.js';

const runtime = createRailwayRuntime(readConfig());
try {
  await runtime.reconcile();
  console.log(await runtime.smoke());
  console.log(runtime.status());
} finally {
  await runtime.close();
}
```

This fixed smoke proves only basic API authorization, file/command access and
cleanup for that run. It does not prove downloaded-code containment. Record the
SDK version, environment, credential mode, run ID, bounded timing and provider
cleanup read-back without recording credentials.

Before executable plugins can activate, live adversarial verification must cover:

- Core filesystem, database, environment and unrelated secret separation.
- Private-network isolation and the actual public-internet boundary.
- Enforceable requested network permissions. `ISOLATED` still permits public
  internet; destination allowlists and deny-all egress are currently unsupported.
- CPU/memory/storage ceilings, output floods, cancellation and runaway children.
- Lost create responses, core termination during every lifecycle phase, durable
  deadlines, restart cleanup and independent provider read-back.
- Approval revocation and pinned artifact/configuration behavior during draining,
  update and rollback, through a real separately installed plugin.

A mock or fixed smoke cannot satisfy these gates. Do not replace the unavailable
state with an enable flag to bypass them.

## Verification references

- [Railway Sandbox overview](https://docs.railway.com/sandboxes)
- [Railway Sandbox quickstart](https://docs.railway.com/sandboxes/quickstart)
- [Pinned SDK execution implementation](https://github.com/railwayapp/railway-ts-sdk/blob/4504d8aa28861f23466cd3a9e3df03bac8b78227/src/sandbox/exec.ts)
- [Pinned SDK creation and cleanup implementation](https://github.com/railwayapp/railway-ts-sdk/blob/4504d8aa28861f23466cd3a9e3df03bac8b78227/src/sandbox/engine.ts)

Local tests exercise lifecycle decisions with a controlled SDK boundary, plus the
real SDK's project-token HTTP header and create-response capture. They make no
claims about a live Railway deployment or sandbox isolation.
