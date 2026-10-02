# Plugins and company customization

Rove core owns the administrator account, conversations, approvals and storage.
Company instructions and integrations belong to independently released packages.
Updating Rove does not require a company fork.

## Categories and current support

| Category | Contract | This release |
| --- | --- | --- |
| Agent Plugin | Skills, instructions and remote MCP | Versioned installation and activation |
| User Plugin | Rove-specific executable company extension | Offline operations, company pages and dashboard actions |
| Channel Plugin | Rove-specific messaging adapter | Installable signed JSON protocol; bundled Slack remains available |

Downloaded JavaScript never runs in the core process. User Plugin operations run
in fresh Railway sandboxes with a guarded offline executor. Missing isolation
controls reject each invocation. Live Railway compatibility has not been verified.
Shell hooks, local MCP processes, arbitrary HTML and plugin database migrations
are rejected. There is no public marketplace yet.
See [format import compatibility](compatibility.md), the
[Railway executor](railway-sandbox.md) and [channel protocol](channel-plugins.md).

## Install and configure

1. In **Customize Rove → Plugins**, approve an exact `owner/repository`. Public
   repositories need no token; private ones need a token with Contents read access.
2. Enter a published release tag and choose its format. Preparation downloads and
   validates content, without activating it or running installation scripts.
3. Inspect the content, source commit and digest. Fill required settings and
   secrets, and explicitly grant requested permissions. Channel access rules
   belong to the administrator and cannot be supplied by the package. Saving configuration
   deactivates an active installation; activate separately after reviewing it.
4. Select **Activate release**. Rove validates required fields and discovers MCP
   tools before switching the active version in one database transaction. Failure
   retains the previous active version. Each subsequent tool call still requires
   administrator approval of its arguments.

Prepare another version without interrupting the active one. Select a cached
older version and activate it to roll back future behavior. Deactivation or source
revocation blocks future dispatch once accepted; it cannot undo an external
request already sent. Changes require any current plugin call to finish first. A single
process and replica are required.

Every switch, configuration change and rollback creates new approval revisions.
Previously approved calls cannot silently authorize changed behavior. A process
exit after dispatch leaves an uncertain outcome that is never replayed.

## Native API v1 package

Commit `rove-plugin.json` at the package repository root and attach those exact
bytes as `rove-plugin.json` to its GitHub release. The release tag must resolve to
that source commit. Rove downloads the artifact without running code and compares
it with the committed file. No archive extraction or package manager runs.

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "company-handbook",
  "name": "Company handbook",
  "version": "1.0.0",
  "category": "agent",
  "description": "Shared company response guidance",
  "skills": [{ "name": "Tone", "markdown": "Use ${settings.tone} language." }],
  "settings": [{ "key": "tone", "label": "Tone", "type": "text", "required": true }],
  "servers": [{ "id": "knowledge", "name": "Knowledge", "url": "https://tools.example.com/mcp", "secret": "api-key" }],
  "secrets": [{ "key": "api-key", "label": "API key", "required": true }],
  "capabilities": ["mcp:knowledge"]
}
```

The example endpoint is illustrative and must be replaced. The package
validator is [plugin-manifest.ts](../src/plugin-manifest.ts). Unknown fields fail
closed. API/schema version must be `1`; package versions use numeric `major.minor.patch`.
IDs and field keys are lowercase hyphenated slugs. Duplicate contribution IDs,
undeclared secret references and unsupported capabilities are rejected.

Settings support text and booleans, optional defaults and required fields.
`${settings.KEY}` in skill/instruction text inserts only a declared ordinary
setting. Secrets cannot be interpolated into prompts. Settings pages are rendered
by core with native controls and text; a manifest cannot inject scripts or HTML.
Custom pages render as plain text under **Pages & actions**, with native action
buttons. Scripts, HTML and style injection are not supported. Pages without
operations work without sandbox credentials or a model connection.

Secrets have one selected source: an encrypted stored value, or an explicitly
bound deployment variable named `ROVE_PLUGIN_SECRET_*`. Rove does not expose its
general process environment. Bound values are read during activation. A changed
or removed environment secret deactivates the installation at restart and
invalidates pending approvals; review and activate again. Tokens are never
returned by the administration API or copied into artifacts.

MCP permissions name a whole remote connection: `mcp:SERVER_ID`.
Granting one exposes its discovered tools to the agent; the existing per-call
approval remains mandatory. This does not enforce resource-level permissions
inside the external service. Scope the service credential accordingly.

## Offline User Plugin operations

A native User Plugin can add one JavaScript module and up to eight operations.
The module exports `async function run({ operation, args, settings })` and returns
a JSON-serializable value. It receives ordinary declared settings only. It has no
network access, secrets, package installation or host filesystem access. Use
separately approved remote MCP tools for external systems.

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "company-summary",
  "name": "Company summary",
  "version": "1.0.0",
  "category": "user",
  "description": "Summarize text supplied by an administrator.",
  "capabilities": ["execute:offline"],
  "execution": {
    "runtime": "node",
    "source": "export async function run({args}) { return args.text.trim(); }"
  },
  "operations": [{
    "id": "summarize",
    "name": "Summarize text",
    "description": "Trim the supplied text.",
    "inputSchema": {
      "type": "object",
      "properties": { "text": { "type": "string", "maxLength": 4000 } },
      "required": ["text"],
      "additionalProperties": false
    },
    "surfaces": ["tool", "action", "step"]
  }],
  "pages": [{
    "id": "summary",
    "title": "Company summary",
    "content": "Supply text and review the action in chat.",
    "actions": ["summarize"]
  }]
}
```

`tool` and `step` operations are available to the agent through its existing
six-call loop. A step is an approved agent operation, not a background scheduler
or separate workflow engine. `action` adds a dashboard button; request it from
**Pages & actions**, then separately approve its exact arguments in chat. Actions
work without a model connection. All surfaces use the same operation and revision.

Activation requires sandbox credentials and an explicit `execute:offline` grant.
Credentials mean the runtime is configured, not that live containment is proven.
Each invocation checks native isolation before loading source. An updated package,
settings, permissions, rollback or source revocation invalidates old approvals.
The dashboard also binds the revision displayed when the action was requested.
Source/configuration changes are refused while an operation is running; retry
after completion. Shutdown cancels the runtime rather than replaying work.

Arguments are validated against the declared JSON schema before dispatch and
limited to 16 KB. Module source is limited to 32 KB, results to 16 KiB, and guest
execution to 15 seconds. See the executor documentation for resource limits,
cleanup behavior and live verification gaps.

## Provenance, storage and limits

Approved-source identity is independent of package category. Approval does not
auto-install or auto-activate releases. Replacing an already installed version
with different bytes is rejected; publish a new version instead. Identical
artifact bytes cannot be claimed by a second repository in the same deployment.

Immutable artifact bytes, settings, encrypted secrets, source identity and audit
records are stored in the volume-backed SQLite database. The browser receives
content and secret status, never secret values. Imported Agent Plugins retain
their original format, source commit and per-file digests separately from the
normalized Rove manifest; they are not labeled native release assets.

Limits: 16 sources, 16 installations, 16 retained releases per installation,
128 KB native manifests, 8 skills, 8 MCP connections, 16 ordinary settings and
8 secrets per package. Existing shared limits remain: 32 extension records,
24,000 instruction characters, 8 MCP servers and 32 combined MCP tools and plugin operations. Limits include
local and installed contributions. Cache pruning is not yet exposed.

Native package AIPs have a smaller limit: the whole draft/revision request,
including proposal text and source, must fit within 16,000 UTF-8 bytes. Model
output limits may require a smaller proposal. The installer's 128 KB limit does
not imply that chat can generate or stage a package of that size.

## Upgrading existing deployments

Stop the old service and back up the complete SQLite database before upgrading.
Keep `BETTER_AUTH_SECRET`. New tables and the AIP workflow setting are additive;
existing skill/MCP IDs, encrypted credentials, conversations, Slack state and
proposal IDs remain. Local skill bundles are labeled **Local bundles**.
Installed content is read-only in the local editors.

Previously adopted AIPs remain legacy local content. Pending published or
interrupted-adoption AIPs cannot use the removed direct-adoption tool; they must
pass final review and release verification. Legacy single-file proposals need a
new compatible package proposal. Uncertain publications cannot auto-republish.

Database compatibility does not make downgrading safe: older Rove versions do
not understand managed ownership or the new release gate. For recovery, stop
Rove and restore the pre-upgrade backup with its matching old container. A plugin
rollback changes future behavior only and never reverses external writes.
