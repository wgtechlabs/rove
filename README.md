<img src="public/brand/icon.svg" alt="rove cyan round avatar" width="80" height="80">

# rove

**Your company’s agent, shaped by your workflows.**

Brand assets: [transparent SVG icon](public/brand/icon.svg), with local idle,
thinking and unsure expressions. See the [Rove avatar guide](public/brand/README.md). The lowercase
wordmark uses Fredoka SemiBold 600; the product interface uses Inter.
See [DESIGN.md](DESIGN.md) and the [font licenses](public/fonts/README.md).

Rove is a self-hosted, company-neutral AI agent. Configure a
shared agent through the web, connect to your tools and channels,
and teach through reviewed **Agent Improvement Proposals (AIPs)**. Your company
supplies the knowledge, policies and workflows.

> **MVP preview:** web chat, approved tool execution, Markdown skills, declarative
> release installations, remote MCP, optional Slack, and reviewed AIP releases are implemented.
> Offline User Plugin tools, dashboard actions and pages are implemented.
> Live Railway containment and template installation still need validation.
> Installable channels currently support a signed JSON protocol; provider-specific plugins are separate work.
> Bring your own provider and integration credentials. Live compatibility depends
> on your provider and installed integrations.

[Quick start](#quick-start) · [Railway](#deploy-on-railway) ·
[Connect a model](#connect-a-model) · [Development](#development)

## What’s ready

| Capability | Status |
| --- | --- |
| Web interface with Rove’s cyan identity | Available |
| Protected first-admin setup, sign-in and account recovery | Available |
| PostgreSQL storage, pgvector readiness, Redis runtime state and Docker configuration | Available |
| AI web chat with saved conversations | Available |
| Web configuration for model connection and system instructions | Available |
| Optional Slack channel, activated from the web interface | Implemented |
| Installable signed JSON channel gateway | Implemented; provider plugins are separate |
| Web configuration for tools, MCP servers, plugins and skills | Implemented |
| Approved GitHub releases, plugin settings, activation and rollback | Implemented |
| AIP final review, GitHub release verification and separate activation | Implemented |
| User Plugin tools, dashboard actions, pages and agent workflow steps | Implemented; every operation requires approval |
| Railway Sandbox execution | Implemented with per-call isolation checks; live compatibility unverified |

The MVP starts with one company and one administrator per deployment. Web setup
requires no Slack or AI-provider credentials. A Rove CLI, Discord and Telegram
are outside the MVP. See [PRODUCT.md](PRODUCT.md) for the product direction.

## Quick start

Install **Node.js 24** and **Bun 1.3.10**. Bun manages dependencies and scripts;
Node runs the server and integration tests. Run **PostgreSQL 18 with pgvector**
and **Redis 8.2** locally using Docker Compose:

```sh
git clone https://github.com/wgtechlabs/rove.git
cd rove
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres redis
```

Generate **two different secrets**, each at least 32 characters, and save them as
`BETTER_AUTH_SECRET` and `ROVE_SETUP_SECRET` in `.env`. To generate a secret, run
this command once for each value:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The example connects to PostgreSQL on `127.0.0.1:54329` and Redis on
`127.0.0.1:6389`. Compose keeps both services in named volumes. The local database
and Redis passwords are for development only; use generated credentials on a
deployment host. Redis requires authentication and uses append-only persistence.
Custom Compose `REDIS_PASSWORD` values must contain only letters, numbers, `.`,
`_`, `~` and `-` so they can be used directly in the connection URL. Compose
rejects other characters at startup. This restriction applies only to the local
Compose stack; hosted deployments use their provider's connection URL.

Build and start Rove:

```sh
bun run build
node --env-file=.env dist/src/server.js
```

Open [localhost:3000](http://localhost:3000), enter your setup secret and create
the administrator account. Save the one-time recovery key in a password manager,
then sign in.

After setup, remove `ROVE_SETUP_SECRET` from `.env` and restart. The database
keeps setup closed. Keep `BETTER_AUTH_SECRET` stable across restarts. Then
[connect a model](#connect-a-model) from the web interface.

## Deploy on Railway

Use three services: **Rove**, **PostgreSQL 18 with pgvector**, and **Redis 8.2**.
PostgreSQL and Redis need persistent volumes; Rove does not need a volume.

1. Add Railway's native PostgreSQL and Redis services. The PostgreSQL 18 image
   includes pgvector. Keep their generated credentials and persistent volumes;
   enable Redis append-only persistence while retaining its authenticated start
   command. Keep both services on private networking.
2. Use `wgtechlabs/rove:1.0.1` or `ghcr.io/wgtechlabs/rove:1.0.1` for Rove.
   Set `DATABASE_URL=${{Postgres.DATABASE_URL}}` and
   `REDIS_URL=${{Redis.REDIS_URL}}`, matching the database service names.
   Configure HTTP port `3000` and healthcheck `/health`.
3. Generate a public domain. Set `ROVE_URL` to its exact HTTPS origin, with no
   trailing slash. Set separate random `BETTER_AUTH_SECRET` and
   `ROVE_SETUP_SECRET` values in the Rove service variables.
4. Deploy, open the domain and create your administrator account. Save the
   recovery key, stop Rove, remove `ROVE_SETUP_SECRET`, then start its replacement.

See [Railway template configuration](docs/railway-template.md) for volumes,
reference variables and generated secrets. The saved template is configured for
this three-service layout and Rove v1.0.1. A fresh live template installation
still needs verification; the template is not yet listed in the marketplace.

Run **one Rove replica**. Redis coordinates core ownership, active turns and
credential attempt limits. Rove refuses to start without PostgreSQL, pgvector or
Redis; loss of Redis ownership stops new work. This does not enable multiple
active replicas. Rove listens on the assigned `PORT`, serves `/health` only while
its dependencies are available, and drains work before releasing its connections.
The image runs as the non-root `node` user.

For each Railway update or redeploy, stop the old Rove deployment before starting
its replacement; allow up to 30 seconds for ownership expiry after a crash. Set
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` for graceful shutdown. This requires a
short outage: Railway rolling deployment waits for the new healthcheck while
Rove requires exclusive ownership. See the [update procedure](docs/railway-template.md#restarts-and-updates).

New installations start with a **fresh PostgreSQL database**. For existing data,
follow the [storage upgrade guidance](docs/railway-template.md#storage-upgrades)
before changing application or database versions.
The vector extension is enabled for future use; semantic retrieval is not included.

### Run with Docker locally

Prepare `.env` using the quick start above, then run all three services:

```sh
docker compose --profile app up -d --build --wait
```

Open [localhost:3000](http://localhost:3000). The app uses private Compose service
addresses; PostgreSQL and Redis data survive app recreation in named volumes.
`docker compose down` stops the stack and retains those volumes. Removing volumes
with `docker compose down -v` deletes the stored data. Secrets and old local
databases are excluded from the image. A published image is not required.

PostgreSQL 18 uses a separate named volume from the previous PostgreSQL 17
development stack. Existing data is not upgraded or imported automatically.
Preserve the old volume and use PostgreSQL's dump/restore process to move data.

## Connect a model

1. Sign in and open **Model settings**.
2. Enter the provider’s API base URL (for example, `https://api.openai.com/v1`),
   an exact model ID available to your account, and your API key. Rove appends
   `/chat/completions` to the base URL. Hosted endpoints require HTTPS; HTTP is
   accepted only on loopback for local development.
3. Optionally add system instructions describing how Rove should respond.
4. Save settings, return to chat and send a message. Saving validates the settings;
   the first reply verifies the provider connection.

The endpoint must support OpenAI-compatible Chat Completions with text messages,
`stream: false` and `max_completion_tokens`. Replies are limited to 2,048 tokens
(including reasoning where the provider uses it). Provider billing and available
models come from your own account. Connected tools also require compatible
function calling. Native Anthropic, file uploads and streaming are outside this MVP.

Your API key stays on the server, encrypted in PostgreSQL using a key derived from
`BETTER_AUTH_SECRET`; it is never returned by the settings API. Leave the key
field blank to retain it. Changing the endpoint requires a new key. **Disconnect
model** removes the active key while keeping conversations. If the authentication
secret changes, re-enter the provider key. Protect database backups and the
application secret together; conversations themselves are stored as plain text.

Messages and system instructions are sent to your chosen provider. Completed
exchanges are saved in PostgreSQL and survive restarts. A failed reply leaves the draft
available to retry. Pending actions and completed tool results are persisted so
approvals survive reloads and interrupted replies can continue without repeating actions. Rove waits up to 60
seconds for a reply and cancels pending requests on shutdown with a retryable
error. Drafts are held in the current browser page and are lost on reload.

This preview runs one reply at a time, supports 200 conversations with up to 100
replies each, and accepts messages up to 4,000 characters. Each request includes
at most the latest 20 exchanges within a 60,000-character history budget. Older
history remains visible but may not be sent to the model. Start a new conversation
when you reach its limit. Conversation deletion is not available yet.

## Customize your agent

Open **Customize Rove** after signing in:

- **Skills:** add Markdown instructions and explicitly enable them. Up to 8,000
  characters per skill and 24,000 across saved skills and bundles.
- **Plugins:** approve an exact GitHub repository, prepare a release, review its
  contents and permissions, configure settings and secrets, then activate it.
  Keep previous versions for rollback. See the [package contract](docs/plugins.md)
  and [supported imports](docs/compatibility.md).
- **Pages & actions:** open company pages and request actions from active plugins.
  Review and approve each action in chat; dashboard actions need no model connection.
- **Local bundles:** keep existing locally edited groups of Markdown skills.
  Released plugin content is immutable and managed from Plugins.
- **Tools & MCP:** save a remote Streamable HTTP endpoint and optional bearer
  token, enable it, then select **Discover tools**. All discovered tools on an
  enabled connection are available to the model. Every call pauses for an
  administrator to approve its exact arguments or deny it.

Approvals expire after 15 minutes and become invalid when the relevant connection
or proposal changes. Rove permits at most six tool calls per message. A failed
model continuation can resume from its saved tool result. An uncertain external
outcome is never silently retried; check the external system before requesting
another action. Conversation messages, proposal drafts, approval arguments and
tool results are stored in PostgreSQL as plaintext; integration credentials are encrypted.

MCP limits: eight servers, 32 combined MCP tools and plugin operations, four catalog pages, and
text/JSON results up to 16 KB. Public HTTPS endpoints are required; loopback HTTP
is available only when Rove itself uses a loopback development URL. Redirects,
private network destinations, schema references and regex patterns are rejected.
Local stdio servers and OAuth are outside this MVP. Re-discover tools after changing
a connection. Only connect servers your company trusts.

### Enable Slack

1. Create and install a Slack app with `app_mentions:read`, `im:history`, and
   `chat:write`. Subscribe to `app_mention` and `message.im`; enable the App Home
   Messages tab.
2. Under **Customize Rove → Slack**, save the bot token, signing secret, allowed
   user IDs, allowed channel IDs, and explicit administrator user IDs. Every Slack
   administrator must also be an allowed user. Enable DMs only if wanted.
3. Use `https://YOUR-ROVE-HOST/api/slack/events` for Event Subscriptions and
   `https://YOUR-ROVE-HOST/api/slack/interactivity` for Interactivity.
4. Enable the connection, mention Rove in an allowed channel, and verify a reply.
   Saving checks the bot token; successful Slack URL verification and a real reply
   are still needed to verify the installation.

Empty allowlists deny access. External shared channels, bots and unsupported
message types are ignored. Replies and approval buttons stay in the originating
thread, and web history is isolated from Slack history. Channel follow-ups must
mention Rove. An administrator must participate in the original conversation to
approve tools: a non-admin's private DM cannot receive another person's approval.
Use an allowed channel with an administrator for that work.

Slack events are acknowledged into a durable queue and deduplicated. Delivered
queue payloads are cleared immediately; terminal job metadata and failed or
uncertain deliveries expire after seven days. Older approval buttons expire with
their origin record. Active work and conversation history are retained. Rate-limited
responses retry from the saved reply. Unknown delivery outcomes are retained for
manual checking instead of blindly posting duplicates. Run one replica.

### Improve through AIPs

Connect your **company's repository** under **GitHub & AIPs**, using a scoped token
with Contents and Pull requests read/write permission. Ask Rove to draft an Agent
Improvement Proposal in web chat or Slack. Review its title, summary, proposed
skill, rationale and validation plan; request revisions or cancellation there.

Drafting and publishing remain separate administrator-reviewed calls. A proposal
includes its next numeric package version. Publishing creates a draft PR with
`.rove/skills/<name>.md` and a matching `rove-plugin.json`; it never merges it.
Proposals can include a complete native plugin package, preserving its source,
settings and permissions in that same review. Package ID and version must match
the proposal. Preparing executable source does not enable its execution.
The complete native-package draft or revision is limited to 16,000 UTF-8 bytes,
including its proposal text; the model's output limit may be smaller.
Inspect the final PR revision in the originating conversation and explicitly
approve that exact revision. The same administrator may author and review it.

After merge, the company's release workflow must pass for that merge commit and
publish a tagged release containing the exact committed `rove-plugin.json` asset.
Configure the required workflow path in **GitHub & AIPs** (default:
`.github/workflows/plugin-release.yml`); the token also needs Actions read access.
Ask Rove to verify the release tag, then separately approve activation in that
conversation. The company repository must also be approved under **Plugins**.
Rove checks the final head, permitted file changes, merge, workflow identity,
source commit and artifact bytes. Changed or missing evidence blocks activation.
AIP-bound packages cannot bypass this gate through the general installer.
If a release requires settings, secrets or permissions, configure it in Plugins
and return to the originating conversation to approve activation again.

The old merged-skill adoption path is closed. Previously adopted local content
keeps working; pending legacy single-file proposals need a compatible package
proposal and release. Company release-workflow templates and separate production
plugin repositories are later deliveries.

Each conversation supports 100 proposals. Proposals do not include conversation
transcripts or source-channel URLs in PR bodies. Review the proposed text for
company-sensitive information before approving publication. If publication has an
unknown outcome, reconcile the recorded branch and GitHub PR manually; Rove blocks
republication of that proposal to prevent duplicates.

## Configuration

Use [.env.example](.env.example) for local development and service variables on
your deployment host.

| Variable | Purpose |
| --- | --- |
| `ROVE_URL` | Exact public origin, without a trailing slash. HTTPS required except on loopback. |
| `BETTER_AUTH_SECRET` | Random authentication secret, at least 32 characters. Keep stable. |
| `ROVE_SETUP_SECRET` | Different random secret, at least 32 characters. Required until the first administrator is created. |
| `DATABASE_URL` | Required PostgreSQL connection URL. The server must have pgvector installed; the database role must be able to enable the extension and create tables. |
| `REDIS_URL` | Required Redis connection URL. Use persistent Redis with AOF enabled. |
| `ROVE_STATE_KEY_PREFIX` | Optional Redis key namespace; defaults to `rove`. All processes for one deployment must use the same value. Use a separate namespace for an independent deployment sharing Redis. |
| `PORT` | Server port; defaults to `3000`. |
| `RAILWAY_ENVIRONMENT_ID` | Automatically supplied on Railway; optional for web use. |
| `RAILWAY_API_TOKEN` / `RAILWAY_TOKEN` | Optional sandbox administration credentials; see [auth modes](docs/railway-sandbox.md). |
| `ROVE_PLUGIN_SECRET_*` | Optional deployment secrets explicitly bound to a plugin. |

## Access and recovery

- Setup creates one administrator and closes permanently for that database.
  There is no public registration, second-admin flow or social login.
- Email is a login identifier. This build does not verify email ownership or
  send password-reset email.
- Better Auth handles password hashing and HTTP-only session cookies. HTTPS
  uses Secure cookies. Sessions expire after eight hours; sign-out revokes the
  session immediately. Administrative access is checked on the server.
- **Forgot your password?** accepts the saved recovery key and a new password.
  Recovery revokes existing sessions and replaces the key. Save the new key;
  the previous key cannot be reused. The setup secret cannot recover an account.
- Credential endpoints allow 10 attempts per minute per action across the
  deployment in Redis. This limit is shared by all callers and survives application
  restarts. Redis persistence controls its recovery after a Redis restart.

Back up PostgreSQL using its supported backup tools and retain the matching
`BETTER_AUTH_SECRET` securely. Accounts, sessions, recovery state, conversations,
plugin releases and durable jobs live in PostgreSQL. Redis holds temporary runtime
ownership, turn state and credential attempt limits; keep its AOF volume persistent.
Restoring an old PostgreSQL backup can restore old passwords, sessions and recovery
keys. Verify recovery using the matching application version before relying on a backup.

If both the password and recovery key are lost, use your company’s backup
recovery procedure. This build has no authentication bypass.

## Development

```sh
bun run check       # Biome formatting, lint and import checks
bun run format      # Apply formatting
bun run typecheck
bun run test
```

Start the local dependencies with `docker compose up -d --wait postgres redis`
before running tests. Tests use real PostgreSQL with pgvector, Redis and Better Auth
sessions with dummy credentials, covering
setup races, authorization, recovery, session revocation, restarts and limits.
Chat tests exercise a local HTTP provider to verify request compatibility,
encrypted configuration, saved history, retries and failure handling. They do not
call a live model or prove compatibility with every provider. Tool-loop tests cover
restart/crash recovery and approval replay. MCP tests use real local HTTP/SSE
servers; Slack and GitHub tests use controlled API boundaries. These do not prove
your live Slack installation, GitHub token, or hosted MCP server configuration.
Plugin tests cover immutable installs, source revocation, separate activation,
rollback, encrypted bindings and transaction rollback. Railway tests use a fake
provider boundary and the pinned SDK transport; live containment remains unverified.
Each integration test uses an isolated database and Redis namespace. The test
PostgreSQL role needs permission to create and drop databases. To use other local
services, set `TEST_DATABASE_URL` (defaults to
`postgres://rove:rove@127.0.0.1:54329/postgres`) and `TEST_REDIS_URL` (defaults to
`redis://:rove@127.0.0.1:6389`). Tests must use disposable development
services. If you change Compose credentials or host ports, set these test URLs
to match; tests do not use the application's production connection variables.

To check container persistence and shutdown across the three-service stack:

```sh
docker build -t rove:foundation .
node scripts/check-container.mjs
```

The smoke test reuses the storage services in `compose.yaml` under a unique
project with random host ports and disposable credentials. It checks Redis
authentication and persistence, pgvector, saved login and chat, and graceful
shutdown, then removes only its own containers and volumes.

Read [AGENTS.md](AGENTS.md) for contribution and commit conventions,
[DESIGN.md](DESIGN.md) for the visual direction, and
[build and release automation](docs/automation.md) for CI and publishing setup.
Releases use `GITHUB_TOKEN`; only qualifying pushes to `main` can publish.

## License

Copyright (C) 2026 Rove contributors.

Rove is licensed under the **GNU General Public License v3.0 only**
([GPL-3.0-only](LICENSE)), without any warranty. See [LICENSE](LICENSE) for the
full terms. Distributed containers include the license and application source.

Bundled [fonts](public/fonts/README.md) retain their SIL Open Font License 1.1.
Third-party dependencies retain their respective licenses and notices.
