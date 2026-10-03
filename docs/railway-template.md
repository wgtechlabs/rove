# Railway template configuration

This is the three-service specification for the next PostgreSQL-based Rove
image. The saved Railway template still targets **v0.2.0** and has not been
updated to this layout. Publish the new application image before changing that
template. A fresh live installation of this layout still needs verification.

## Services

Create these services in the same Railway project and environment. Keep the data
services on private networking; only Rove needs a public HTTP domain.

| Service | Image or source | Persistent volume | Settings |
| --- | --- | --- | --- |
| `Postgres` | `pgvector/pgvector:pg17` | `/var/lib/postgresql/data` | PostgreSQL port `5432`; pgvector is installed in this image. |
| `Redis` | `redis:7-alpine` | `/data` | Redis port `6379`; start with `redis-server --appendonly yes`. |
| `Rove` | A versioned `ghcr.io/wgtechlabs/rove` image containing this change, or the matching stable source release | None | Public HTTP port `3000`, healthcheck `/health`, one replica. |

The checked-in `railway.json` sets the Dockerfile and healthcheck for source
builds. Set the health path separately when configuring an image deployment.
Rove enables the `vector` extension during database initialization; the PostgreSQL
role must have permission to enable it and create the application tables. This
makes the database ready for vectors; semantic retrieval is not implemented.

## Variables

Set these variables on **Postgres**:

| Variable | Template value |
| --- | --- |
| `POSTGRES_USER` | `rove` |
| `POSTGRES_DB` | `rove` |
| `POSTGRES_PASSWORD` | `${{secret(64, "abcdef0123456789")}}` |
| `DATABASE_URL` | `postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}` |

Set `REDIS_URL=redis://${{RAILWAY_PRIVATE_DOMAIN}}:6379` on **Redis**. This Redis
service must remain private; the proposed image command enables AOF persistence.
If using a separately managed Redis service, use its authenticated connection URL
and persistent storage instead.

Set these variables on **Rove**. Reference names must match the service names
above:

| Variable | Template value |
| --- | --- |
| `ROVE_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `BETTER_AUTH_SECRET` | `${{secret(64)}}` |
| `ROVE_SETUP_SECRET` | `${{secret(64)}}` as a separate generated value |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `ROVE_STATE_KEY_PREFIX` | `rove` (optional; this is the default) |
| `PORT` | `3000` |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15` |

Railway generates application secrets at installation. They must differ, and the
authentication secret must stay stable. Open the domain, use the setup secret to
create the admin and save the recovery key. Then remove the setup secret using
the stop/start procedure below. Model, GitHub and Slack credentials are configured
afterward in Rove; web setup requires none of those credentials.

Both data services are required. Rove fails startup if PostgreSQL, pgvector or
Redis is unavailable, and rejects new work after losing Redis ownership. All Rove
processes for one deployment must use the same Redis namespace. Use separate
namespaces for independent deployments sharing Redis, each with its own database.
The PostgreSQL database owns durable account, conversation, approval, plugin and
queue state; Redis owns temporary coordination and credential attempt limits.

## Restarts and updates

Run one active Rove core. **Stop the old Rove deployment before starting its
replacement**, including changes to variables, images or source. Confirm it has
stopped, then start the new deployment. Graceful shutdown releases ownership;
after a crash, allow up to 30 seconds for the Redis lease to expire. Plan for a
short outage. Keep PostgreSQL and Redis running during an ordinary app update.

Railway normally keeps the previous deployment running until its replacement
passes its healthcheck. Rove's exclusive ownership prevents that replacement from
starting while the old core is active. Setting overlap time to zero does not
change this order. Automatic rolling updates and zero-downtime upgrades are not
supported by this version. See Railway's [healthcheck behavior](https://docs.railway.com/deployments/healthchecks)
and [deployment teardown settings](https://docs.railway.com/deployments/deployment-teardown).

Start this storage version with a **fresh PostgreSQL database**. There is no
SQLite importer. Preserve old data files, backups and the matching authentication
secret for recovery with their old image. Before later PostgreSQL-based upgrades,
back up PostgreSQL and test recovery with a matching application version. Rove
requires no app volume; keep the PostgreSQL and Redis volumes persistent.

## Optional integrations and verification

The built-in MCP client connects to remote endpoints configured in Rove. This
template does not provision third-party MCP servers. No continuously running
sandbox is needed for ordinary web chat or declarative plugins.

Railway supplies `RAILWAY_ENVIRONMENT_ID` automatically. Sandbox administration
credentials remain optional owner-supplied secrets with an explicit auth mode
when needed. A template cannot mint account permissions. See
[Railway Sandbox setup and remaining verification](railway-sandbox.md).

After deployment authorization, verify fresh setup and web chat, install a
declarative release, and use the stop/start procedure twice to confirm state and
rollback. Check PostgreSQL and Redis persistence, then test core and plugin
updates independently. Before relying on executable plugins in production,
complete the separate live containment checks. The implementation checks isolation
on every call and refuses execution when the environment lacks the required
capabilities. A container build or mocked API test does not verify that journey.

Reference: Railway's [template editor and variable functions](https://docs.railway.com/templates/create).
