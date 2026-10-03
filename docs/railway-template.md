# Railway template configuration

The saved template uses **Rove v1.0.1**, Railway's native **PostgreSQL 18**
service with pgvector, and native **Redis 8.2**. Its configuration has been saved
and read back; a fresh live installation still needs verification. Deploy from
the [published Railway template](https://railway.com/deploy/rove), or use the
configuration below for manual installation.

## Services

Create these services in the same Railway project and environment. Keep the data
services on private networking; only Rove needs a public HTTP domain.

| Service | Image or source | Persistent volume | Settings |
| --- | --- | --- | --- |
| `Postgres` | `ghcr.io/railwayapp-templates/postgres-ssl:18` | `/var/lib/postgresql/data` | Private port `5432`; keep `PGDATA=/var/lib/postgresql/data/pgdata`. The native image includes pgvector. |
| `Redis` | `redis:8.2` | `/data` | Private port `6379`; preserve the generated password and enable append-only persistence. |
| `rove` | `wgtechlabs/rove:1.0.1` or `ghcr.io/wgtechlabs/rove:1.0.1` | None | Public HTTP port `3000`, healthcheck `/health`, one replica. |

The checked-in `railway.json` sets the Dockerfile and healthcheck for source
builds. Set the health path separately when configuring an image deployment.
Rove enables the `vector` extension during database initialization; the PostgreSQL
role must have permission to enable it and create the application tables. This
makes the database ready for vectors; semantic retrieval is not implemented.
Railway's [PostgreSQL 18 image](https://github.com/railwayapp-templates/postgres-ssl/blob/92c18579d2610d5bf7715e60a4340a25401932bb/Dockerfile.18)
already installs pgvector. Keep the native volume mount and `PGDATA` subdirectory;
do not substitute the upstream PostgreSQL image's default data path.

The local [Compose stack](../compose.yaml), CI and container smoke checks share
these database image versions. Compose uses development-only credentials; Railway
generates deployment credentials independently.

## Variables

Railway's native services provide their variables automatically. Keep the
generated passwords and private URLs rather than copying local development
credentials. These are the values relevant to Rove on **Postgres**:

| Variable | Template value |
| --- | --- |
| `POSTGRES_USER` | `postgres` (native default) |
| `POSTGRES_DB` | `railway` (native default) |
| `POSTGRES_PASSWORD` | Native generated secret |
| `PGDATA` | `/var/lib/postgresql/data/pgdata` |
| `DATABASE_URL` | Native private URL using the generated user, password, database and `RAILWAY_PRIVATE_DOMAIN` |

On **Redis**, retain the native `REDISUSER`, `REDIS_PASSWORD`, `REDISHOST`,
`REDISPORT` and authenticated `REDIS_URL` variables. The saved template adds
`--appendonly yes` to Railway's native start command:

```sh
/bin/sh -c "rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --appendonly yes --dir $RAILWAY_VOLUME_MOUNT_PATH"
```

Both databases remain private: do not add HTTP or TCP proxies. If using separately
managed databases, supply their authenticated connection URLs and persistent
storage instead.

Set these variables on **rove**. Reference names must match the service names
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

## Storage upgrades

New installations use a **fresh PostgreSQL database**. Before upgrading an
existing PostgreSQL deployment, back up the database and test recovery with a
matching application version and authentication secret. Keep the PostgreSQL and
Redis volumes persistent; Rove itself requires no app volume.

PostgreSQL major versions do not share interchangeable data directories. The local
Compose stack uses a new `postgres-18-data` volume and leaves the old
`postgres-data` volume untouched. To retain PostgreSQL 17 data, export it using
the old image, then restore into a fresh PostgreSQL 18 database before starting
Rove. Do not attach the old volume to the new image or delete it before verifying
the restored data. Merely changing an image tag does not perform a database
upgrade.

Deployments from before the PostgreSQL migration have no automatic SQLite
importer. `ROVE_DATABASE_PATH` is no longer read. Preserve those database files,
backups, their matching authentication secret and the old image for recovery;
starting Rove v1.0.0 does not import existing accounts or conversations.

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
