import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { agentFormat, importAgentRelease } from './agent-import.js';
import type { ReleasedSkill } from './aip.js';
import { loadRelease, tagSchema, type VerifiedRelease } from './aip-release.js';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import {
  type createExtensions,
  discoverTools,
  type ManagedExtension,
} from './extensions.js';
import { mcpURL } from './mcp.js';
import { type ActiveChannel, channelAccess } from './plugin-channel.js';
import {
  compatibility,
  type PluginPackage,
  parsePackage,
  repositoryName,
} from './plugin-manifest.js';
import {
  checkOperationArguments,
  operationDefinition,
  type PluginRuntime,
} from './plugin-operations.js';
import { createSecrets } from './secrets.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const target = z.object({ id: z.uuid(), revision: z.uuid() }).strict();
const activation = target.extend({ digest: digestSchema });
const sourceInput = z
  .object({
    repo: repositoryName,
    approved: z.boolean(),
    token: z.string().trim().max(1000).optional(),
    clearToken: z.boolean().optional(),
  })
  .strict();
const installInput = z
  .object({
    repo: repositoryName,
    tag: tagSchema,
    format: z.union([z.literal('rove'), agentFormat]).default('rove'),
  })
  .strict();
const secretBinding = z.discriminatedUnion('source', [
  z
    .object({ source: z.literal('stored'), value: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      source: z.literal('environment'),
      name: z.string().regex(/^ROVE_PLUGIN_SECRET_[A-Z0-9_]{1,80}$/),
    })
    .strict(),
  z.object({ source: z.literal('remove') }).strict(),
]);
const configuration = activation.extend({
  values: z.record(z.string(), z.union([z.string().max(2000), z.boolean()])),
  secrets: z.record(z.string(), secretBinding).default({}),
  grants: z.array(z.string().max(160)).max(16),
  channelAccess: channelAccess.optional(),
});
type Binding =
  | { source: 'stored'; encrypted: string }
  | { source: 'environment'; name: string };
interface Installation {
  id: string;
  repo: string;
  pluginId: string;
  active: string | null;
  revision: string;
  values: Record<string, string | boolean>;
  secrets: Record<string, Binding>;
  grants: string[];
  environmentFingerprint?: string;
  channelAccess?: z.infer<typeof channelAccess>;
}
type ReleaseSummary = Pick<
  PluginPackage,
  'name' | 'description' | 'category' | 'version'
> & { tag: string };
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      'Invalid plugin request. Check the fields and selected version.',
    );
  return result.data;
}

/** Immutable releases and dashboard-owned configuration. Downloaded JavaScript never enters the host. */
export function createPlugins(
  config: Config,
  extensions: ReturnType<typeof createExtensions>,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: PluginRuntime,
) {
  const db = new DatabaseSync(config.databasePath);
  const secrets = createSecrets(config.authSecret);
  try {
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rove_plugin_source(repo TEXT PRIMARY KEY, token TEXT NOT NULL, approved INTEGER NOT NULL, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rove_plugin_installation(id TEXT PRIMARY KEY, repo TEXT NOT NULL, plugin_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(repo,plugin_id));
      CREATE TABLE IF NOT EXISTS rove_plugin_artifact(digest TEXT PRIMARY KEY, repo TEXT NOT NULL, plugin_id TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL, summary TEXT, UNIQUE(repo,plugin_id,version));
      CREATE TABLE IF NOT EXISTS rove_plugin_audit(id INTEGER PRIMARY KEY, installation TEXT NOT NULL, event TEXT NOT NULL, digest TEXT, at INTEGER NOT NULL);`);
    if (
      !db
        .prepare('PRAGMA table_info(rove_plugin_artifact)')
        .all()
        .some((column) => column.name === 'summary')
    )
      db.exec('ALTER TABLE rove_plugin_artifact ADD COLUMN summary TEXT');
    // Display metadata is stored once; only selected review and execution read verified artifact bytes.
    db.exec(`UPDATE rove_plugin_artifact SET summary=json_object(
      'name',json_extract(data,'$.manifest.name'),
      'description',json_extract(data,'$.manifest.description'),
      'category',json_extract(data,'$.manifest.category'),
      'version',version,'tag',json_extract(data,'$.tag')) WHERE summary IS NULL`);
  } catch (error) {
    db.close();
    throw error;
  }
  const lifetime = new AbortController();
  let closed = false;
  let busy = false;
  // ponytail: one executable plugin call per deployment; add per-installation leases if throughput requires them.
  let executing = false;
  function mutable() {
    if (closed) throw new HttpError(503, 'Plugins are shutting down.');
    if (executing)
      throw new HttpError(
        409,
        'Wait for the current plugin call before changing plugins.',
      );
  }
  const source = (repo: string) =>
    db.prepare('SELECT * FROM rove_plugin_source WHERE repo=?').get(repo);
  function installations(): Installation[] {
    return db
      .prepare('SELECT data FROM rove_plugin_installation ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  function get(id: string) {
    const item = installations().find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, 'Plugin installation not found.');
    return item;
  }
  function current(id: string, revision: string) {
    const item = get(id);
    if (item.revision !== revision)
      throw new HttpError(
        409,
        'Plugin settings changed. Reload and review them again.',
      );
    return item;
  }
  function write(
    connection: DatabaseSync,
    item: Installation,
    event: string,
    digest: string | null = item.active,
  ) {
    item.revision = randomUUID();
    connection
      .prepare(
        'INSERT INTO rove_plugin_installation VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(item.id, item.repo, item.pluginId, JSON.stringify(item));
    connection
      .prepare(
        'INSERT INTO rove_plugin_audit(installation,event,digest,at) VALUES(?,?,?,?)',
      )
      .run(item.id, event, digest, Date.now());
  }
  function artifact(digest: string): VerifiedRelease {
    const row = db
      .prepare('SELECT data FROM rove_plugin_artifact WHERE digest=?')
      .get(digest);
    if (!row) throw new HttpError(404, 'Plugin release not found.');
    const release = JSON.parse(String(row.data)) as VerifiedRelease;
    if (hash(release.bytes) !== digest)
      throw new HttpError(
        409,
        'The cached artifact failed its integrity check. Restore a verified backup.',
      );
    return { ...release, manifest: parsePackage(JSON.parse(release.bytes)) };
  }
  function selected(item: Installation, digest: string) {
    const release = artifact(digest);
    if (
      release.repo.toLowerCase() !== item.repo ||
      release.manifest.id !== item.pluginId
    )
      throw new HttpError(400, 'This release belongs to another installation.');
    return release;
  }
  function detail(id: string, digest: string) {
    const release = selected(
      get(parse(z.uuid(), id)),
      parse(digestSchema, digest),
    );
    return {
      digest: release.digest,
      tag: release.tag,
      commit: release.commit,
      manifest: release.manifest,
      origin: release.origin,
      blocked: compatibility(release.manifest, runtime?.status().configured),
    };
  }
  function assertApproved(repo: string) {
    const row = source(repo);
    if (!row?.approved)
      throw new HttpError(
        409,
        'Approve this GitHub repository before installing or activating its plugins.',
      );
    return row;
  }
  function list() {
    return {
      sources: db
        .prepare(
          'SELECT repo,approved,token FROM rove_plugin_source ORDER BY repo',
        )
        .all()
        .map((row) => ({
          repo: String(row.repo),
          approved: Boolean(row.approved),
          configured: Boolean(row.token),
        })),
      installations: installations().map((item) => ({
        id: item.id,
        repo: item.repo,
        pluginId: item.pluginId,
        active: item.active,
        revision: item.revision,
        values: item.values,
        grants: item.grants,
        channelAccess: item.channelAccess,
        secrets: Object.fromEntries(
          Object.entries(item.secrets).map(([key, binding]) => [
            key,
            {
              source: binding.source,
              ...(binding.source === 'environment'
                ? { name: binding.name }
                : {}),
              configured:
                binding.source === 'stored' || Boolean(env[binding.name]),
            },
          ]),
        ),
        versions: db
          .prepare(
            'SELECT digest,summary FROM rove_plugin_artifact WHERE repo=? AND plugin_id=? ORDER BY rowid DESC',
          )
          .all(item.repo, item.pluginId)
          .map((row) => ({
            digest: String(row.digest),
            ...(JSON.parse(String(row.summary)) as ReleaseSummary),
          })),
        audit: db
          .prepare(
            'SELECT event,digest,at FROM rove_plugin_audit WHERE installation=? ORDER BY id DESC LIMIT 30',
          )
          .all(item.id),
      })),
      executable: {
        available: Boolean(runtime?.status().configured),
        reason: runtime?.status().configured
          ? 'Custom code runs offline in Railway Sandbox with approval for each call. Live Railway behavior must be verified on your deployment.'
          : 'Configure Railway Sandbox to activate executable User Plugins. Custom code receives ordinary settings and approved input, never credentials or network access.',
      },
    };
  }
  function saveSource(body: unknown) {
    mutable();
    const input = parse(sourceInput, body);
    if (/[\r\n]/.test(input.token ?? '') || (input.token && input.clearToken))
      throw new HttpError(
        400,
        'Enter a replacement GitHub token or clear the saved token.',
      );
    const previous = source(input.repo);
    if (
      !previous &&
      Number(
        db.prepare('SELECT COUNT(*) AS count FROM rove_plugin_source').get()
          ?.count,
      ) >= 16
    )
      throw new HttpError(409, 'Keep at most 16 approved repositories.');
    const revoked = input.approved
      ? []
      : installations().filter(
          (entry) => entry.repo === input.repo && entry.active,
        );
    extensions.deactivateManaged(
      revoked.map((item) => item.id),
      (connection) => {
        connection
          .prepare(
            'INSERT INTO rove_plugin_source VALUES(?,?,?,?) ON CONFLICT(repo) DO UPDATE SET token=excluded.token,approved=excluded.approved,revision=excluded.revision',
          )
          .run(
            input.repo,
            input.clearToken
              ? ''
              : input.token
                ? secrets.encrypt(input.token)
                : String(previous?.token ?? ''),
            Number(input.approved),
            randomUUID(),
          );
        for (const item of revoked) {
          item.active = null;
          write(connection, item, 'source-revoked');
        }
      },
    );
    return list();
  }
  function stageRelease(release: VerifiedRelease) {
    const repo = parse(repositoryName, release.repo);
    assertApproved(repo);
    const manifest = parsePackage(JSON.parse(release.bytes));
    if (hash(release.bytes) !== release.digest)
      throw new HttpError(409, 'Release digest does not match its bytes.');
    const sameBytes = db
      .prepare('SELECT repo,plugin_id FROM rove_plugin_artifact WHERE digest=?')
      .get(release.digest);
    if (
      sameBytes &&
      (sameBytes.repo !== repo || sameBytes.plugin_id !== manifest.id)
    )
      throw new HttpError(
        409,
        'These identical artifact bytes are already associated with another source.',
      );
    for (const server of manifest.servers) mcpURL(server.url, config.baseURL);
    const previous = db
      .prepare(
        'SELECT digest FROM rove_plugin_artifact WHERE repo=? AND plugin_id=? AND version=?',
      )
      .get(repo, manifest.id, manifest.version);
    if (previous && previous.digest !== release.digest)
      throw new HttpError(
        409,
        'This version was already installed with different bytes. Publish a new version.',
      );
    if (previous) {
      const pinned = artifact(String(previous.digest));
      if (
        pinned.tag !== release.tag ||
        pinned.commit !== release.commit ||
        pinned.assetId !== release.assetId ||
        JSON.stringify(pinned.origin) !== JSON.stringify(release.origin)
      )
        throw new HttpError(
          409,
          'This version is already pinned to a different release identity. Publish a new version rather than replacing its source or notices.',
        );
    }
    let item = installations().find(
      (entry) => entry.repo === repo && entry.pluginId === manifest.id,
    );
    if (!item && installations().length >= 16)
      throw new HttpError(
        409,
        'This deployment supports 16 plugin installations.',
      );
    if (
      !previous &&
      Number(
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM rove_plugin_artifact WHERE repo=? AND plugin_id=?',
          )
          .get(repo, manifest.id)?.count,
      ) >= 16
    )
      throw new HttpError(
        409,
        'This installation retains at most 16 releases. Export a backup before pruning through a future maintenance release.',
      );
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO rove_plugin_artifact(digest,repo,plugin_id,version,data,summary) VALUES(?,?,?,?,?,?) ON CONFLICT(digest) DO NOTHING',
      ).run(
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
      );
      if (!item) {
        item = {
          id: randomUUID(),
          repo,
          pluginId: manifest.id,
          active: null,
          revision: randomUUID(),
          values: {},
          secrets: {},
          grants: [],
        };
        write(db, item, 'installed', release.digest);
      } else if (!previous) write(db, item, 'release-prepared', release.digest);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return item;
  }
  async function install(body: unknown) {
    const input = parse(installInput, body);
    const approved = assertApproved(input.repo);
    const request = {
      repo: input.repo,
      tag: input.tag,
      token: approved.token
        ? secrets.decrypt(String(approved.token))
        : undefined,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(60000)]),
    };
    const release =
      input.format === 'rove'
        ? await loadRelease(request, fetchImpl)
        : await importAgentRelease(
            { ...request, format: input.format },
            fetchImpl,
          );
    if (source(input.repo)?.revision !== approved.revision)
      throw new HttpError(
        409,
        'Repository approval changed during download. Start again.',
      );
    stageRelease(release);
    return list();
  }
  function validateValues(
    pkg: PluginPackage,
    item: Installation,
    required: boolean,
  ) {
    if (
      Object.keys(item.values).some(
        (key) => !pkg.settings.some((field) => field.key === key),
      ) ||
      Object.keys(item.secrets).some(
        (key) => !pkg.secrets.some((field) => field.key === key),
      ) ||
      item.grants.some((grant) => !pkg.capabilities.includes(grant))
    )
      throw new HttpError(
        400,
        'Settings, secrets and permissions must be declared by this release.',
      );
    const values: Record<string, string | boolean> = {};
    for (const field of pkg.settings) {
      const value = item.values[field.key] ?? field.default;
      if (
        value !== undefined &&
        typeof value !== (field.type === 'text' ? 'string' : 'boolean')
      )
        throw new HttpError(400, `Invalid setting: ${field.label}.`);
      if (required && field.required && (value === undefined || value === ''))
        throw new HttpError(
          400,
          `Complete the required setting: ${field.label}.`,
        );
      if (value !== undefined) values[field.key] = value;
    }
    return values;
  }
  function configure(body: unknown) {
    mutable();
    const input = parse(configuration, body);
    const item = current(input.id, input.revision);
    const pkg = selected(item, input.digest).manifest;
    item.values = input.values;
    item.grants = [...new Set(input.grants)];
    if (input.channelAccess && !pkg.channel)
      throw new HttpError(
        400,
        'Channel access rules require a Channel Plugin.',
      );
    item.channelAccess = input.channelAccess;
    for (const [key, binding] of Object.entries(input.secrets)) {
      if (binding.source === 'remove') delete item.secrets[key];
      else
        item.secrets[key] =
          binding.source === 'stored'
            ? { source: 'stored', encrypted: secrets.encrypt(binding.value) }
            : binding;
    }
    validateValues(pkg, item, false);
    item.active = null;
    extensions.deactivateManaged(item.id, (connection) =>
      write(connection, item, 'configuration-saved', input.digest),
    );
    return list();
  }
  function secretValue(item: Installation, key: string) {
    const binding = item.secrets[key];
    const value =
      binding?.source === 'stored'
        ? secrets.decrypt(binding.encrypted)
        : binding?.source === 'environment'
          ? (env[binding.name] ?? '')
          : '';
    if (value.length > 2000 || /[\r\n]/.test(value))
      throw new HttpError(400, 'A bound plugin credential is invalid.');
    return value;
  }
  function environmentFingerprint(item: Installation) {
    return createHmac('sha256', config.authSecret)
      .update(
        JSON.stringify(
          Object.entries(item.secrets)
            .filter(
              (
                entry,
              ): entry is [string, { source: 'environment'; name: string }] =>
                entry[1].source === 'environment',
            )
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, binding]) => [
              key,
              binding.name,
              env[binding.name] ?? '',
            ]),
        ),
      )
      .digest('hex');
  }
  async function prepare(
    item: Installation,
    pkg: PluginPackage,
    signal: AbortSignal,
  ): Promise<ManagedExtension[]> {
    const blocked = compatibility(pkg, runtime?.status().configured);
    if (blocked) throw new HttpError(409, blocked);
    if (pkg.channel && !channelAccess.safeParse(item.channelAccess).success)
      throw new HttpError(
        400,
        'Configure the channel workspace, allowed users and destinations before activation.',
      );
    const values = validateValues(pkg, item, true);
    if (
      pkg.capabilities.some((capability) => !item.grants.includes(capability))
    )
      throw new HttpError(
        409,
        'Grant each requested permission before activation.',
      );
    for (const field of pkg.secrets)
      if (field.required && !secretValue(item, field.key))
        throw new HttpError(
          400,
          `Configure the required secret: ${field.label}.`,
        );
    const interpolate = (value: string) =>
      value.replace(/\$\{settings\.([^}]+)\}/g, (_match, key: string) =>
        String(values[key] ?? ''),
      );
    const id = (key: string) => {
      const hex = hash(`${item.id}:${key}`);
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    };
    const entries: ManagedExtension[] = [];
    const skills = [
      ...pkg.skills,
      ...(pkg.instructions
        ? [{ name: 'Instructions', markdown: pkg.instructions }]
        : []),
    ];
    for (const [index, skill] of skills.entries())
      entries.push({
        id: id(`skill:${index}`),
        entry: {
          kind: 'skill',
          name: `${pkg.name}: ${skill.name}`.slice(0, 80),
          markdown: interpolate(skill.markdown),
          enabled: true,
        },
        credential: '',
        tools: [],
      });
    for (const server of pkg.servers) {
      const token = server.secret ? secretValue(item, server.secret) : '';
      const url = mcpURL(server.url, config.baseURL);
      const tools = await discoverTools(url, token, config.baseURL, signal);
      entries.push({
        id: id(`server:${server.id}`),
        entry: {
          kind: 'server',
          name: `${pkg.name}: ${server.name}`.slice(0, 80),
          url,
          enabled: true,
        },
        credential: token ? secrets.encrypt(token) : '',
        tools,
      });
    }
    return entries;
  }
  function requireAipGate(release: VerifiedRelease, aipId?: string) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='rove_aip'",
        )
        .get()
    )
      return;
    const related = db
      .prepare(`SELECT data FROM rove_aip WHERE lower(json_extract(data,'$.repo'))=?
      AND json_extract(data,'$.skillName')=? AND coalesce(json_extract(data,'$.packageVersion'),'1.0.0')=?`)
      .all(
        release.repo.toLowerCase(),
        release.manifest.id,
        release.manifest.version,
      );
    if (!related.length) return;
    const proposals = related.map(
      (row) =>
        JSON.parse(String(row.data)) as {
          id: string;
          status: string;
          review?: { headSha: string };
          candidateHead?: string;
          release?: { digest: string; commit: string; assetId: number };
        },
    );
    const permitted = proposals.some((proposal) => {
      const pinned =
        proposal.release?.digest === release.digest &&
        proposal.release.commit === release.commit &&
        proposal.release.assetId === release.assetId;
      return (
        pinned &&
        (aipId
          ? aipId === proposal.id &&
            proposal.status === 'activating' &&
            typeof proposal.candidateHead === 'string' &&
            proposal.review?.headSha === proposal.candidateHead
          : proposal.status === 'activated')
      );
    });
    if (!permitted)
      throw new HttpError(
        409,
        'This package belongs to an AIP. Complete its final review, release verification and activation in the originating conversation.',
      );
  }

  async function activate(body: unknown, aipId?: string) {
    const input = parse(activation, body);
    const item = current(input.id, input.revision);
    const sourceRevision = assertApproved(item.repo).revision;
    const release = selected(item, input.digest);
    requireAipGate(release, aipId);
    const entries = await prepare(
      item,
      release.manifest,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
    );
    current(item.id, item.revision);
    requireAipGate(release, aipId);
    if (assertApproved(item.repo).revision !== sourceRevision)
      throw new HttpError(
        409,
        'Repository approval changed. Review activation again.',
      );
    item.active = release.digest;
    item.environmentFingerprint = environmentFingerprint(item);
    const operationCount = installations().reduce(
      (count, entry) =>
        count +
        (entry.id === item.id
          ? release.manifest.operations.length
          : entry.active
            ? selected(entry, entry.active).manifest.operations.length
            : 0),
      0,
    );
    const serverCount =
      extensions
        .list()
        .servers.filter(
          (server) => server.enabled && server.managedBy !== item.id,
        )
        .reduce((count, server) => count + server.tools.length, 0) +
      entries.reduce((count, entry) => count + entry.tools.length, 0);
    if (operationCount + serverCount > 32)
      throw new HttpError(
        409,
        'Enable at most 32 MCP and plugin operations across this deployment.',
      );
    extensions.replaceManaged(item.id, entries, (connection) =>
      write(connection, item, 'activated', release.digest),
    );
    return list();
  }
  function deactivate(body: unknown) {
    mutable();
    const input = parse(target, body);
    const item = current(input.id, input.revision);
    item.active = null;
    extensions.deactivateManaged(item.id, (connection) =>
      write(connection, item, 'deactivated'),
    );
    return list();
  }
  function activeChannel(id: string): ActiveChannel | undefined {
    if (closed) return;
    const item = installations().find((entry) => entry.id === id);
    if (!item?.active || !source(item.repo)?.approved) return;
    const pkg = selected(item, item.active).manifest;
    if (
      !pkg.channel ||
      !item.channelAccess ||
      pkg.capabilities.some(
        (capability) => !item.grants.includes(capability),
      ) ||
      item.environmentFingerprint !== environmentFingerprint(item)
    )
      return;
    return {
      ...channelAccess.parse(item.channelAccess),
      revision: item.revision,
      digest: item.active,
      spec: pkg.channel,
      secrets: Object.fromEntries(
        [pkg.channel.signing.secret, pkg.channel.outgoing.secret].map((key) => [
          key,
          secretValue(item, key),
        ]),
      ),
    };
  }
  function activeContributions() {
    if (closed) throw new HttpError(503, 'Plugins are shutting down.');
    const executionTarget = runtime?.status();
    return installations().flatMap((item) => {
      if (
        !item.active ||
        !source(item.repo)?.approved ||
        item.environmentFingerprint !== environmentFingerprint(item)
      )
        return [];
      const pkg = selected(item, item.active).manifest;
      if (
        compatibility(pkg, executionTarget?.configured) ||
        pkg.capabilities.some((grant) => !item.grants.includes(grant))
      )
        return [];
      const values = validateValues(pkg, item, true);
      if (
        pkg.secrets.some(
          (field) => field.required && !secretValue(item, field.key),
        )
      )
        return [];
      const revision = hash(
        JSON.stringify([
          item.revision,
          item.active,
          values,
          item.grants,
          item.environmentFingerprint,
          executionTarget?.environmentId ?? null,
          executionTarget?.authType ?? null,
        ]),
      );
      return [
        {
          item,
          pkg,
          values,
          operations: pkg.operations.map((operation) => ({
            operation,
            definition: operationDefinition(item.id, revision, operation),
          })),
        },
      ];
    });
  }
  function operationCatalog() {
    const available = activeContributions();
    const count =
      available.reduce((sum, entry) => sum + entry.operations.length, 0) +
      extensions
        .list()
        .servers.filter((server) => server.enabled)
        .reduce((sum, server) => sum + server.tools.length, 0);
    if (count > 32)
      throw new HttpError(
        409,
        'Enable at most 32 MCP and plugin operations across this deployment.',
      );
    return available;
  }
  function contributions() {
    return {
      plugins: operationCatalog()
        .filter(
          ({ pkg }) =>
            pkg.pages.length ||
            pkg.operations.some((operation) =>
              operation.surfaces.includes('action'),
            ),
        )
        .map(({ item, pkg, operations }) => ({
          id: item.id,
          name: pkg.name,
          pages: pkg.pages.map((page) => ({
            ...page,
            actions: page.actions.flatMap((id) =>
              operations
                .filter(({ operation }) => operation.id === id)
                .map(({ definition }) => definition.name),
            ),
          })),
          actions: operations.flatMap(({ definition, operation }) =>
            definition.surfaces?.includes('action')
              ? [{ ...definition, label: operation.name }]
              : [],
          ),
        })),
    };
  }
  function findOperation(name: string) {
    for (const entry of operationCatalog()) {
      const operation = entry.operations.find(
        ({ definition }) => definition.name === name,
      );
      if (operation) return { ...entry, ...operation };
    }
    throw new HttpError(409, 'This plugin operation is no longer enabled.');
  }
  async function execute(
    name: string,
    args: Record<string, unknown>,
    revision: string,
    signal: AbortSignal,
  ) {
    const entry = findOperation(name);
    if (entry.definition.revision !== revision)
      throw new HttpError(
        409,
        'The plugin configuration changed. Request a new approval.',
      );
    const input = structuredClone(args);
    await checkOperationArguments(entry.definition, input);
    mutable();
    if (busy)
      throw new HttpError(
        409,
        'Wait for the current plugin change before running an operation.',
      );
    if (findOperation(name).definition.revision !== revision)
      throw new HttpError(
        409,
        'The plugin configuration changed. Request a new approval.',
      );
    if (!runtime || !entry.pkg.execution)
      throw new HttpError(409, 'Plugin execution is unavailable.');
    const operationSignal = AbortSignal.any([signal, lifetime.signal]);
    operationSignal.throwIfAborted();
    executing = true;
    try {
      const result = await runtime.execute(
        {
          source: entry.pkg.execution.source,
          operation: entry.operation.id,
          args: input,
          settings: entry.values,
        },
        operationSignal,
      );
      operationSignal.throwIfAborted();
      if (findOperation(name).definition.revision !== revision)
        throw new HttpError(
          409,
          'The plugin configuration changed during execution.',
        );
      return result;
    } finally {
      executing = false;
      if (closed && !busy) db.close();
    }
  }
  async function run<T>(action: () => Promise<T>) {
    mutable();
    if (busy)
      throw new HttpError(
        409,
        'Another plugin operation is running. Wait for it to finish.',
      );
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
      if (closed) db.close();
    }
  }
  try {
    // Deployment-variable rotation invalidates cached credentials and pending approvals before chat starts.
    for (const item of installations())
      if (
        item.active &&
        Object.values(item.secrets).some(
          (binding) => binding.source === 'environment',
        ) &&
        item.environmentFingerprint !== environmentFingerprint(item)
      ) {
        item.active = null;
        extensions.deactivateManaged(item.id, (connection) =>
          write(connection, item, 'environment-secret-changed'),
        );
      }
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    list,
    detail,
    saveSource,
    configure,
    deactivate,
    activeChannel,
    contributions,
    tools: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return operationCatalog().flatMap((entry) =>
        entry.operations.map(({ definition }) => definition),
      );
    },
    execute,
    preview: (name: string, args: Record<string, unknown>) => {
      const { pkg, operation } = findOperation(name);
      return `${pkg.name}: ${operation.name}\nOffline custom code; no network or credentials.\n${JSON.stringify(args, null, 2)}`;
    },
    install: (body: unknown) => run(() => install(body)),
    activate: (body: unknown) => run(() => activate(body)),
    activateRelease: (skill: ReleasedSkill) =>
      run(async () => {
        const item = stageRelease(skill.release);
        requireAipGate(skill.release, skill.id);
        if (item.active === skill.release.digest) return;
        await activate(
          {
            id: item.id,
            revision: item.revision,
            digest: skill.release.digest,
          },
          skill.id,
        );
      }),
    close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      if (!busy && !executing) db.close();
    },
  };
}
