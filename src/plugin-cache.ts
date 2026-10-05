import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { VerifiedRelease } from './aip-release.js';
import { HttpError } from './auth.js';
import type { Database, Sql } from './database.js';
import {
  type PluginPackage,
  parsePackage,
  repositoryName,
} from './plugin-manifest.js';

type ReleaseSummary = Pick<
  PluginPackage,
  'name' | 'description' | 'category' | 'version'
> & { tag: string };
interface CacheOwner {
  id: string;
  repo: string;
  pluginId: string;
  active: string | null;
}
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Payloads are disposable; release identities and provenance are permanent. */
export async function createPluginCache(db: Database) {
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_plugin_artifact(digest TEXT PRIMARY KEY, repo TEXT NOT NULL, plugin_id TEXT NOT NULL, version TEXT NOT NULL, data TEXT, summary TEXT, identity TEXT, sequence BIGINT GENERATED ALWAYS AS IDENTITY, UNIQUE(repo,plugin_id,version));
    ALTER TABLE rove_plugin_artifact ALTER COLUMN data DROP NOT NULL;
    ALTER TABLE rove_plugin_artifact ADD COLUMN IF NOT EXISTS identity TEXT;
    ALTER TABLE rove_plugin_artifact ADD COLUMN IF NOT EXISTS summary TEXT;
    UPDATE rove_plugin_artifact SET identity=(data::jsonb - 'bytes' - 'manifest')::text WHERE identity IS NULL AND data IS NOT NULL;
    UPDATE rove_plugin_artifact SET summary=jsonb_build_object(
      'name',data::jsonb->'manifest'->>'name',
      'description',data::jsonb->'manifest'->>'description',
      'category',data::jsonb->'manifest'->>'category',
      'version',version,'tag',data::jsonb->>'tag')::text WHERE summary IS NULL AND data IS NOT NULL;`);

  async function artifact(digest: string): Promise<VerifiedRelease> {
    const row = await db.get(
      'SELECT data FROM rove_plugin_artifact WHERE digest=$1',
      [digest],
    );
    if (!row) throw new HttpError(404, 'Plugin release not found.');
    if (row.data === null)
      throw new HttpError(
        409,
        'This release payload was pruned. Download the exact original release before using it.',
      );
    const release = JSON.parse(String(row.data)) as VerifiedRelease;
    if (hash(release.bytes) !== digest)
      throw new HttpError(
        409,
        'The cached artifact failed its integrity check. Restore a verified backup.',
      );
    return { ...release, manifest: parsePackage(JSON.parse(release.bytes)) };
  }

  async function store(tx: Sql, release: VerifiedRelease) {
    const repo = repositoryName.parse(release.repo);
    const manifest = parsePackage(JSON.parse(release.bytes));
    if (hash(release.bytes) !== release.digest)
      throw new HttpError(409, 'Release digest does not match its bytes.');
    const sameBytes = await tx.get(
      'SELECT repo,plugin_id FROM rove_plugin_artifact WHERE digest=$1',
      [release.digest],
    );
    if (
      sameBytes &&
      (sameBytes.repo !== repo || sameBytes.plugin_id !== manifest.id)
    )
      throw new HttpError(
        409,
        'These identical artifact bytes are already associated with another source.',
      );
    const previous = await tx.get(
      'SELECT digest,identity,data IS NOT NULL AS cached FROM rove_plugin_artifact WHERE repo=$1 AND plugin_id=$2 AND version=$3',
      [repo, manifest.id, manifest.version],
    );
    if (previous && previous.digest !== release.digest)
      throw new HttpError(
        409,
        'This version was already installed with different bytes. Publish a new version.',
      );
    if (previous) {
      const pinned = JSON.parse(String(previous.identity)) as Omit<
        VerifiedRelease,
        'bytes' | 'manifest'
      >;
      if (
        pinned.tag !== release.tag ||
        pinned.commit !== release.commit ||
        pinned.assetId !== release.assetId ||
        !isDeepStrictEqual(pinned.origin, release.origin)
      )
        throw new HttpError(
          409,
          'This version is already pinned to a different release identity. Publish a new version rather than replacing its source or notices.',
        );
    }
    if (previous?.cached) {
      await artifact(release.digest);
      return false;
    }
    const count = await tx.get(
      'SELECT COUNT(*) AS count FROM rove_plugin_artifact WHERE repo=$1 AND plugin_id=$2 AND data IS NOT NULL',
      [repo, manifest.id],
    );
    if (Number(count?.count) >= 16)
      throw new HttpError(
        409,
        'This installation caches at most 16 releases. Prune an inactive version before downloading another.',
      );
    const { bytes: _bytes, manifest: _manifest, ...identity } = release;
    await tx.run(
      'INSERT INTO rove_plugin_artifact(digest,repo,plugin_id,version,data,summary,identity) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(digest) DO UPDATE SET data=excluded.data WHERE rove_plugin_artifact.data IS NULL',
      [
        release.digest,
        repo,
        manifest.id,
        manifest.version,
        JSON.stringify({ ...release, repo, manifest }),
        JSON.stringify({
          name: manifest.name,
          description: manifest.description,
          category: manifest.category,
          version: manifest.version,
          tag: release.tag,
        } satisfies ReleaseSummary),
        JSON.stringify({ ...identity, repo }),
      ],
    );
    return true;
  }

  async function versions(item: CacheOwner, connection: Sql = db) {
    const rollback = await connection.get(
      "SELECT digest FROM rove_plugin_audit WHERE installation=$1 AND event='activated' AND digest IS DISTINCT FROM $2 ORDER BY id DESC LIMIT 1",
      [item.id, item.active],
    );
    const rows = await connection.all(
      "SELECT digest,summary,coalesce(identity::jsonb->'origin'->>'format','rove') AS format,data IS NOT NULL AS cached FROM rove_plugin_artifact WHERE repo=$1 AND plugin_id=$2 ORDER BY sequence DESC",
      [item.repo, item.pluginId],
    );
    return rows.map((row) => {
      const digest = String(row.digest);
      const cached = Boolean(row.cached);
      const pruneReason = !cached
        ? 'Payload already pruned; release identity retained.'
        : digest === item.active
          ? 'The active version must remain cached.'
          : digest === rollback?.digest
            ? 'The previous activated version is kept for rollback.'
            : null;
      return {
        digest,
        ...(JSON.parse(String(row.summary)) as ReleaseSummary),
        cached,
        format: String(row.format),
        prunable: pruneReason === null,
        pruneReason,
      };
    });
  }

  async function prune(tx: Sql, item: CacheOwner, digest: string) {
    const release = (await versions(item, tx)).find(
      (entry) => entry.digest === digest,
    );
    if (!release)
      throw new HttpError(
        404,
        'Plugin release not found for this installation.',
      );
    if (!release.prunable)
      throw new HttpError(
        409,
        release.pruneReason ?? 'Release cannot be pruned.',
      );
    await tx.run('UPDATE rove_plugin_artifact SET data=NULL WHERE digest=$1', [
      digest,
    ]);
  }

  return { artifact, store, versions, prune };
}
