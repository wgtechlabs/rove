import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { VerifiedRelease } from '../src/aip-release.js';
import { fixture, manifest, repo } from './plugin-fixture.js';

test('cache migration preserves releases, protects active and rollback versions, and prunes atomically', async (t) => {
  const f = await fixture(t);
  await f.approve();
  let item = await f.install();
  const first = item.versions[0]?.digest;
  assert.ok(first);
  await f.configure();
  await f.activate();
  item = await f.install(manifest('2.0.0'));
  const rollback = item.versions[0]?.digest;
  assert.ok(rollback);
  await f.activate();
  await f.install(manifest('3.0.0'));
  await f.activate();
  item = await f.install(manifest('4.0.0'));
  const unactivated = item.versions[0]?.digest;
  assert.ok(unactivated);
  const active = item.active;
  const before = await f.extensions.instructions();
  const db = f.config.db;
  const oldArtifact = await db.get(
    'SELECT data FROM rove_plugin_artifact WHERE digest=$1',
    [first],
  );
  assert.ok(oldArtifact);
  const release = JSON.parse(String(oldArtifact.data)) as VerifiedRelease;
  // Simulate the previous schema, then prove the additive migration survives restart.
  await db.exec(`ALTER TABLE rove_plugin_artifact DROP COLUMN identity;
    ALTER TABLE rove_plugin_artifact ALTER COLUMN data SET NOT NULL;
    ALTER TABLE rove_plugin_artifact DROP COLUMN summary;`);
  await f.restart();
  assert.deepEqual(await f.current(), item);
  assert.equal(await f.extensions.instructions(), before);
  for (const digest of [active, rollback]) {
    const version = item.versions.find((entry) => entry.digest === digest);
    assert.equal(version?.cached, true);
    assert.equal(version?.prunable, false);
    await assert.rejects(
      f.plugins.prune({ id: item.id, revision: item.revision, digest }),
      /active|rollback/,
    );
  }
  await assert.rejects(
    f.plugins.prune({
      id: item.id,
      revision: item.revision,
      digest: 'f'.repeat(64),
    }),
    /not found/,
  );
  await f.plugins.prune({
    id: item.id,
    revision: item.revision,
    digest: first,
  });
  const pruned = await f.current();
  assert.equal(pruned.active, active);
  assert.deepEqual(pruned.values, item.values);
  assert.deepEqual(pruned.grants, item.grants);
  assert.notEqual(pruned.revision, item.revision);
  assert.equal(await f.extensions.instructions(), before);
  assert.equal(
    pruned.versions.find((entry) => entry.digest === first)?.cached,
    false,
  );
  assert.equal(pruned.audit[0]?.event, 'cache-pruned');
  assert.equal(pruned.audit[0]?.digest, first);
  const receipt = await db.get(
    'SELECT data,identity FROM rove_plugin_artifact WHERE digest=$1',
    [first],
  );
  assert.equal(receipt?.data, null);
  const identity = JSON.parse(String(receipt?.identity));
  assert.equal(identity.digest, first);
  assert.equal(identity.commit, release.commit);
  assert.equal(identity.tag, release.tag);
  assert.equal(identity.repo, repo);
  assert.equal('bytes' in identity, false);
  assert.equal('manifest' in identity, false);
  await assert.rejects(f.plugins.detail(item.id, first), /pruned/);
  await assert.rejects(
    f.plugins.activate({
      id: item.id,
      revision: pruned.revision,
      digest: first,
    }),
    /pruned/,
  );
  await assert.rejects(
    f.plugins.prune({
      id: item.id,
      revision: item.revision,
      digest: unactivated,
    }),
    /settings changed/,
  );
  await assert.rejects(
    f.plugins.configure({
      id: item.id,
      revision: item.revision,
      digest: active,
      values: item.values,
      grants: item.grants,
    }),
    /settings changed/,
  );
  assert.deepEqual(await f.current(), pruned);
  await f.restart();
  assert.deepEqual(await f.current(), pruned);
  await f.plugins.prune({
    id: pruned.id,
    revision: pruned.revision,
    digest: unactivated,
  });
  await f.activate(rollback);
  assert.match(await f.extensions.instructions(), /Policy 2.0.0/);
  const rolledBack = await f.current();
  assert.equal(
    rolledBack.versions.find((entry) => entry.digest === active)?.prunable,
    false,
  );
});

test('the cache ceiling counts payloads and admits a seventeenth release after pruning', async (t) => {
  const f = await fixture(t);
  await f.approve();
  for (let version = 0; version < 16; version++)
    await f.install(manifest(`1.0.${version}`));
  const full = await f.current();
  const oldest = full.versions.at(-1);
  assert.ok(oldest);
  await assert.rejects(f.install(manifest('1.0.16')), /at most 16/);
  await f.plugins.prune({
    id: full.id,
    revision: full.revision,
    digest: oldest.digest,
  });
  const item = await f.install(manifest('1.0.16'));
  assert.equal(item.versions.length, 17);
  assert.equal(
    item.versions.every((release) => release.format === 'rove'),
    true,
  );
  assert.equal(item.versions.filter((release) => release.cached).length, 16);
  assert.equal(
    item.versions.find((release) => release.digest === oldest.digest)?.cached,
    false,
  );
  await assert.rejects(f.install(manifest(oldest.version)), /at most 16/);
  const latest = item.versions[0];
  assert.ok(latest);
  await f.plugins.prune({
    id: item.id,
    revision: item.revision,
    digest: latest.digest,
  });
  const restored = await f.install(manifest(oldest.version));
  assert.equal(restored.versions.length, 17);
  assert.equal(
    restored.versions.filter((release) => release.cached).length,
    16,
  );
  assert.equal(
    restored.versions.find((release) => release.digest === oldest.digest)
      ?.cached,
    true,
  );
});

test('pruned identities prevent replacement bytes and copied provenance while retaining AIP evidence', async (t) => {
  const f = await fixture(t);
  await f.approve();
  await f.install();
  let item = await f.configure();
  const digest = item.versions[0]?.digest;
  assert.ok(digest);
  const db = f.config.db;
  const release = JSON.parse(
    String(
      (
        await db.get('SELECT data FROM rove_plugin_artifact WHERE digest=$1', [
          digest,
        ])
      )?.data,
    ),
  ) as VerifiedRelease;
  await db.exec(
    'CREATE TABLE rove_aip(id TEXT PRIMARY KEY,scope TEXT NOT NULL,data TEXT NOT NULL)',
  );
  const proposal = {
    id: randomUUID(),
    repo,
    skillName: 'company-agent',
    packageVersion: '1.0.0',
    status: 'published',
    rationale: 'Keep the review evidence.',
    release: { digest, commit: release.commit, assetId: release.assetId },
  };
  await db.run('INSERT INTO rove_aip VALUES($1,$2,$3)', [
    proposal.id,
    'web:test',
    JSON.stringify(proposal),
  ]);
  await f.plugins.prune({ id: item.id, revision: item.revision, digest });
  item = await f.current();
  const unchanged = async () => {
    assert.equal((await f.current()).revision, item.revision);
    assert.equal((await f.current()).active, null);
    assert.equal((await f.current()).versions[0]?.cached, false);
  };
  await assert.rejects(
    f.install({ ...manifest(), description: 'Replacement content' }),
    /different bytes/,
  );
  await unchanged();
  f.state.bytes = release.bytes;
  await assert.rejects(
    f.plugins.install({ repo, tag: 'retagged' }),
    /different release identity/,
  );
  f.state.commit = 'b'.repeat(40);
  await assert.rejects(f.install(), /different release identity/);
  f.state.commit = release.commit;
  f.state.assetId = 8;
  await assert.rejects(f.install(), /different release identity/);
  f.state.assetId = 7;
  await assert.rejects(
    f.plugins.activateRelease({
      id: proposal.id,
      name: 'Company agent',
      content: 'Policy',
      enabled: true,
      release: {
        ...release,
        origin: {
          format: 'codex-skill',
          releaseId: 9,
          sourceDigest: 'd'.repeat(64),
          files: [{ path: 'SKILL.md', digest: 'e'.repeat(64) }],
        },
      },
    }),
    /different release identity/,
  );
  await unchanged();
  await f.plugins.saveSource({
    repo: 'other/company-agent',
    approved: true,
    token: 'dummy-github-token',
  });
  await assert.rejects(
    f.plugins.install({ repo: 'other/company-agent', tag: release.tag }),
    /another source/,
  );
  await unchanged();
  await f.restart();
  await f.install();
  await assert.rejects(f.activate(), /belongs to an AIP/);
  assert.deepEqual(
    JSON.parse(
      String(
        (await db.get('SELECT data FROM rove_aip WHERE id=$1', [proposal.id]))
          ?.data,
      ),
    ),
    proposal,
  );
  assert.ok(
    (await f.current()).audit.some(
      (entry) => entry.event === 'cache-pruned' && entry.digest === digest,
    ),
  );
  await db.run('UPDATE rove_aip SET data=$1 WHERE id=$2', [
    JSON.stringify({ ...proposal, status: 'activated' }),
    proposal.id,
  ]);
  await f.activate();
  assert.equal((await f.current()).active, digest);
});

test('pruning waits for release downloads to finish', async (t) => {
  const f = await fixture(t);
  await f.approve();
  const item = await f.install();
  f.state.onFetch = async () => {
    f.state.onFetch = async () => {};
    await assert.rejects(
      f.plugins.prune({
        id: item.id,
        revision: item.revision,
        digest: item.versions[0]?.digest,
      }),
      /Another plugin operation/,
    );
  };
  await f.install(manifest('2.0.0'));
  assert.equal(
    (await f.current()).versions.every((release) => release.cached),
    true,
  );
});
