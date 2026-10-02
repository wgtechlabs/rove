# Railway template configuration

This repository supplies the service build/health configuration and the values
below for Railway's template editor. A published template and a live deployment
are not yet verified. Do not add a Deploy button until a real template URL exists.

Create one service named **Rove** from `wgtechlabs/rove` after the changes reach
a stable release, or select the corresponding versioned `ghcr.io/wgtechlabs/rove`
container image. Attach a volume at `/data`, enable public HTTP networking on port
3000, and keep one replica. The checked-in `railway.json` configures the Dockerfile
and `/health`; image deployments should set that health path in the editor.

Set these values in the template editor:

| Variable | Template value |
| --- | --- |
| `ROVE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `BETTER_AUTH_SECRET` | `${{secret(64)}}` |
| `ROVE_SETUP_SECRET` | `${{secret(64)}}` as a separate generated value |
| `ROVE_DATABASE_PATH` | `/data/rove.sqlite` |
| `PORT` | `3000` |

Railway generates the application secrets at installation. They must differ and
the authentication secret must stay stable. Open the resulting domain, use the
setup secret to create the admin, save the recovery key, then remove the setup
secret. Model, GitHub and Slack credentials are configured afterward in Rove.
Web setup requires none of those credentials.

The built-in MCP client connects to remote endpoints configured in Rove. This
template does not silently provision third-party MCP servers. No continuously
running sandbox is needed for ordinary web chat or declarative plugins.

Railway supplies `RAILWAY_ENVIRONMENT_ID` automatically. Sandbox administration
credentials remain an optional owner-supplied secret, with explicit auth mode
when needed. The template cannot mint account permissions. See
[Railway Sandbox setup and remaining verification](railway-sandbox.md).

After deployment authorization, verify fresh setup and web chat, install a
declarative release, restart twice, confirm state and rollback, then test core
and plugin updates independently. Before enabling executable plugins, complete
the separate live containment checks. Do not mark this journey verified from a
container build or mocked API tests.

Reference: Railway's [template editor and variable functions](https://docs.railway.com/templates/create).
