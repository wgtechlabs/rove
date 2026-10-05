import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agentFormat, importAgentRelease } from './agent-import.js';
import { type ReleasedSkill, requireAipRelease } from './aip.js';
import { loadRelease, tagSchema, type VerifiedRelease } from './aip-release.js';
import { HttpError } from './auth.js';
import type { Sql } from './database.js';
import {
  type createExtensions,
  discoverTools,
  type ManagedExtension,
} from './extensions.js';
import { mcpURL } from './mcp.js';
import { createPluginCache } from './plugin-cache.js';
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
import type { RuntimeConfig } from './runtime.js';
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
export async function createPlugins(
  config: RuntimeConfig,
  extensions: Awaited<ReturnType<typeof createExtensions>>,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
  runtime?: PluginRuntime,
) {
  const db = config.db;
  const secrets = createSecrets(config.authSecret);
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_plugin_source(repo TEXT PRIMARY KEY, token TEXT NOT NULL, approved INTEGER NOT NULL, revision TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rove_plugin_installation(id TEXT PRIMARY KEY, repo TEXT NOT NULL, plugin_id TEXT NOT NULL, data TEXT NOT NULL, sequence BIGINT GENERATED ALWAYS AS IDENTITY, UNIQUE(repo,plugin_id));
    CREATE TABLE IF NOT EXISTS rove_plugin_audit(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, installation TEXT NOT NULL, event TEXT NOT NULL, digest TEXT, at BIGINT NOT NULL);
    CREATE INDEX IF NOT EXISTS rove_plugin_audit_recent ON rove_plugin_audit(installation,id DESC);
    CREATE INDEX IF NOT EXISTS rove_plugin_audit_activated ON rove_plugin_audit(installation,id DESC) WHERE event='activated';
    `);
  const cache = await createPluginCache(db);
  const lifetime = new AbortController();
  const shutdown = AbortSignal.any([lifetime.signal, config.state.signal]);
  let closed = false;
  let busy = false;
  let changing = false;
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
  async function change<T>(action: () => Promise<T>) {
    if (changing)
      throw new HttpError(
        409,
        'Plugin settings changed. Reload and review them again.',
      );
    changing = true;
    try {
      return await action();
    } finally {
      changing = false;
    }
  }
  const source = async (repo: string) =>
    await db.get('SELECT * FROM rove_plugin_source WHERE repo=$1', [repo]);
  async function installations(): Promise<Installation[]> {
    return (
      await db.all(
        'SELECT data FROM rove_plugin_installation ORDER BY sequence',
        [],
      )
    ).map((row) => JSON.parse(String(row.data)));
  }
  async function get(id: string) {
    const item = (await installations()).find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, 'Plugin installation not found.');
    return item;
  }
  async function current(id: string, revision: string) {
    const item = await get(id);
    if (item.revision !== revision)
      throw new HttpError(
        409,
        'Plugin settings changed. Reload and review them again.',
      );
    return item;
  }
  async function write(
    connection: Sql,
    item: Installation,
    event: string,
    digest: string | null = item.active,
  ) {
    const revision = item.revision;
    item.revision = randomUUID();
    const changed = await connection.run(
      "INSERT INTO rove_plugin_installation(id,repo,plugin_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE rove_plugin_installation.data::jsonb->>'revision'=$5",
      [item.id, item.repo, item.pluginId, JSON.stringify(item), revision],
    );
    if (!changed)
      throw new HttpError(
        409,
        'Plugin settings changed. Reload and review them again.',
      );
    await connection.run(
      'INSERT INTO rove_plugin_audit(installation,event,digest,at) VALUES($1,$2,$3,$4)',
      [item.id, event, digest, Date.now()],
    );
  }
  async function selected(item: Installation, digest: string) {
    const release = await cache.artifact(digest);
    if (
      release.repo.toLowerCase() !== item.repo ||
      release.manifest.id !== item.pluginId
    )
      throw new HttpError(400, 'This release belongs to another installation.');
    return release;
  }
  async function detail(id: string, digest: string) {
    const release = await selected(
      await get(parse(z.uuid(), id)),
      parse(digestSchema, digest),
    );
    return {
      digest: release.digest,
      tag: release.tag,
      commit: release.commit,
      manifest: release.manifest,
      origin: release.origin,
      blocked: compatibility(
        release.manifest,
        (await runtime?.status())?.configured,
      ),
    };
  }
  async function assertApproved(repo: string) {
    const row = await source(repo);
    if (!row?.approved)
      throw new HttpError(
        409,
        'Approve this GitHub repository before installing or activating its plugins.',
      );
    return row;
  }
  async function list() {
    return {
      sources: (
        await db.all(
          'SELECT repo,approved,token FROM rove_plugin_source ORDER BY repo',
          [],
        )
      ).map((row) => ({
        repo: String(row.repo),
        approved: Boolean(row.approved),
        configured: Boolean(row.token),
      })),
      installations: await Promise.all(
        (await installations()).map(async (item) => ({
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
          ...(await cache.versions(item)),
          audit: await db.all(
            'SELECT event,digest,at FROM rove_plugin_audit WHERE installation=$1 ORDER BY id DESC LIMIT 30',
            [item.id],
          ),
        })),
      ),
      executable: {
        available: Boolean((await runtime?.status())?.configured),
        reason: (await runtime?.status())?.configured
          ? 'Custom code runs offline in Railway Sandbox with approval for each call. Live Railway behavior must be verified on your deployment.'
          : 'Configure Railway Sandbox to activate executable User Plugins. Custom code receives ordinary settings and approved input, never credentials or network access.',
      },
    };
  }
  async function saveSource(body: unknown) {
    mutable();
    const input = parse(sourceInput, body);
    if (/[\r\n]/.test(input.token ?? '') || (input.token && input.clearToken))
      throw new HttpError(
        400,
        'Enter a replacement GitHub token or clear the saved token.',
      );
    const previous = await source(input.repo);
    if (
      !previous &&
      Number(
        (await db.get('SELECT COUNT(*) AS count FROM rove_plugin_source', []))
          ?.count,
      ) >= 16
    )
      throw new HttpError(409, 'Keep at most 16 approved repositories.');
    const revoked = input.approved
      ? []
      : (await installations()).filter(
          (entry) => entry.repo === input.repo && entry.active,
        );
    await extensions.deactivateManaged(
      revoked.map((item) => item.id),
      async (connection) => {
        await connection.run(
          'INSERT INTO rove_plugin_source VALUES($1,$2,$3,$4) ON CONFLICT(repo) DO UPDATE SET token=excluded.token,approved=excluded.approved,revision=excluded.revision',
          [
            input.repo,
            input.clearToken
              ? ''
              : input.token
                ? secrets.encrypt(input.token)
                : String(previous?.token ?? ''),
            Number(input.approved),
            randomUUID(),
          ],
        );
        for (const item of revoked) {
          item.active = null;
          await write(connection, item, 'source-revoked');
        }
      },
    );
    return await list();
  }
  async function stageRelease(release: VerifiedRelease) {
    const repo = parse(repositoryName, release.repo);
    await assertApproved(repo);
    const manifest = parsePackage(JSON.parse(release.bytes));
    for (const server of manifest.servers) mcpURL(server.url, config.baseURL);
    let item = (await installations()).find(
      (entry) => entry.repo === repo && entry.pluginId === manifest.id,
    );
    if (!item && (await installations()).length >= 16)
      throw new HttpError(
        409,
        'This deployment supports 16 plugin installations.',
      );
    return db.transaction(async (tx) => {
      const downloaded = await cache.store(tx, release);
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
        await write(tx, item, 'installed', release.digest);
      } else if (downloaded)
        await write(tx, item, 'release-prepared', release.digest);
      return item;
    });
  }
  async function install(body: unknown) {
    const input = parse(installInput, body);
    const approved = await assertApproved(input.repo);
    const request = {
      repo: input.repo,
      tag: input.tag,
      token: approved.token
        ? secrets.decrypt(String(approved.token))
        : undefined,
      signal: AbortSignal.any([shutdown, AbortSignal.timeout(60000)]),
    };
    const release =
      input.format === 'rove'
        ? await loadRelease(request, fetchImpl)
        : await importAgentRelease(
            { ...request, format: input.format },
            fetchImpl,
          );
    if ((await source(input.repo))?.revision !== approved.revision)
      throw new HttpError(
        409,
        'Repository approval changed during download. Start again.',
      );
    await stageRelease(release);
    return await list();
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
  async function configure(body: unknown) {
    mutable();
    const input = parse(configuration, body);
    const item = await current(input.id, input.revision);
    const pkg = (await selected(item, input.digest)).manifest;
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
    await extensions.deactivateManaged(
      item.id,
      async (connection) =>
        await write(connection, item, 'configuration-saved', input.digest),
    );
    return await list();
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
    const blocked = compatibility(pkg, (await runtime?.status())?.configured);
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

  async function activate(body: unknown, aipId?: string) {
    const input = parse(activation, body);
    const item = await current(input.id, input.revision);
    const sourceRevision = (await assertApproved(item.repo)).revision;
    const release = await selected(item, input.digest);
    await requireAipRelease(db, release, aipId);
    const entries = await prepare(
      item,
      release.manifest,
      AbortSignal.any([shutdown, AbortSignal.timeout(30000)]),
    );
    await change(async () => {
      await current(item.id, item.revision);
      await requireAipRelease(db, release, aipId);
      if ((await assertApproved(item.repo)).revision !== sourceRevision)
        throw new HttpError(
          409,
          'Repository approval changed. Review activation again.',
        );
      item.active = release.digest;
      item.environmentFingerprint = environmentFingerprint(item);
      let operationCount = 0;
      for (const entry of await installations()) {
        operationCount +=
          entry.id === item.id
            ? release.manifest.operations.length
            : entry.active
              ? (await selected(entry, entry.active)).manifest.operations.length
              : 0;
      }
      const serverCount =
        (await extensions.list()).servers
          .filter((server) => server.enabled && server.managedBy !== item.id)
          .reduce((count, server) => count + server.tools.length, 0) +
        entries.reduce((count, entry) => count + entry.tools.length, 0);
      if (operationCount + serverCount > 32)
        throw new HttpError(
          409,
          'Enable at most 32 MCP and plugin operations across this deployment.',
        );
      await extensions.replaceManaged(
        item.id,
        entries,
        async (connection) =>
          await write(connection, item, 'activated', release.digest),
      );
    });
    return await list();
  }
  async function deactivate(body: unknown) {
    mutable();
    const input = parse(target, body);
    const item = await current(input.id, input.revision);
    item.active = null;
    await extensions.deactivateManaged(
      item.id,
      async (connection) => await write(connection, item, 'deactivated'),
    );
    return await list();
  }
  async function prune(body: unknown) {
    mutable();
    const input = parse(activation, body);
    const item = await current(input.id, input.revision);
    await db.transaction(async (tx) => {
      await cache.prune(tx, item, input.digest);
      await write(tx, item, 'cache-pruned', input.digest);
    });
    return await list();
  }
  async function activeChannel(id: string): Promise<ActiveChannel | undefined> {
    if (closed) return;
    const item = (await installations()).find((entry) => entry.id === id);
    if (!item?.active || !(await source(item.repo))?.approved) return;
    const pkg = (await selected(item, item.active)).manifest;
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
  async function activeContributions() {
    if (closed) throw new HttpError(503, 'Plugins are shutting down.');
    const executionTarget = await runtime?.status();
    return (
      await Promise.all(
        (
          await installations()
        ).map(async (item) => {
          if (
            !item.active ||
            !(await source(item.repo))?.approved ||
            item.environmentFingerprint !== environmentFingerprint(item)
          )
            return [];
          const pkg = (await selected(item, item.active)).manifest;
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
        }),
      )
    ).flat();
  }
  async function operationCatalog() {
    const available = await activeContributions();
    const count =
      available.reduce((sum, entry) => sum + entry.operations.length, 0) +
      (await extensions.list()).servers
        .filter((server) => server.enabled)
        .reduce((sum, server) => sum + server.tools.length, 0);
    if (count > 32)
      throw new HttpError(
        409,
        'Enable at most 32 MCP and plugin operations across this deployment.',
      );
    return available;
  }
  async function contributions() {
    return {
      plugins: (await operationCatalog())
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
  async function findOperation(name: string) {
    for (const entry of await operationCatalog()) {
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
    const entry = await findOperation(name);
    if (entry.definition.revision !== revision)
      throw new HttpError(
        409,
        'The plugin configuration changed. Request a new approval.',
      );
    const input = structuredClone(args);
    await checkOperationArguments(entry.definition, input);
    mutable();
    if (busy || changing)
      throw new HttpError(
        409,
        'Wait for the current plugin change before running an operation.',
      );
    if ((await findOperation(name)).definition.revision !== revision)
      throw new HttpError(
        409,
        'The plugin configuration changed. Request a new approval.',
      );
    if (!runtime || !entry.pkg.execution)
      throw new HttpError(409, 'Plugin execution is unavailable.');
    const operationSignal = AbortSignal.any([signal, shutdown]);
    operationSignal.throwIfAborted();
    mutable();
    if (busy || changing)
      throw new HttpError(
        409,
        'Wait for the current plugin change before running an operation.',
      );
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
      if ((await findOperation(name)).definition.revision !== revision)
        throw new HttpError(
          409,
          'The plugin configuration changed during execution.',
        );
      return result;
    } finally {
      executing = false;
    }
  }
  async function run<T>(action: () => Promise<T>) {
    mutable();
    if (busy || changing)
      throw new HttpError(
        409,
        'Another plugin operation is running. Wait for it to finish.',
      );
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  }
  // Deployment-variable rotation invalidates cached credentials and pending approvals before chat starts.
  for (const item of await installations())
    if (
      item.active &&
      Object.values(item.secrets).some(
        (binding) => binding.source === 'environment',
      ) &&
      item.environmentFingerprint !== environmentFingerprint(item)
    ) {
      item.active = null;
      await extensions.deactivateManaged(
        item.id,
        async (connection) =>
          await write(connection, item, 'environment-secret-changed'),
      );
    }
  return {
    list,
    detail,
    async releaseHistory(id: string, cursor?: string) {
      return cache.releaseHistory(await get(parse(z.uuid(), id)), cursor);
    },
    saveSource: (body: unknown) => change(() => saveSource(body)),
    configure: (body: unknown) => change(() => configure(body)),
    deactivate: (body: unknown) => change(() => deactivate(body)),
    prune: (body: unknown) => run(() => change(() => prune(body))),
    activeChannel,
    contributions,
    tools: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return (await operationCatalog()).flatMap((entry) =>
        entry.operations.map(({ definition }) => definition),
      );
    },
    execute,
    preview: async (name: string, args: Record<string, unknown>) => {
      const { pkg, operation } = await findOperation(name);
      return `${pkg.name}: ${operation.name}\nOffline custom code; no network or credentials.\n${JSON.stringify(args, null, 2)}`;
    },
    install: (body: unknown) => run(() => install(body)),
    activate: (body: unknown) => run(() => activate(body)),
    activateRelease: (skill: ReleasedSkill) =>
      run(async () => {
        const item = await stageRelease(skill.release);
        await requireAipRelease(db, skill.release, skill.id);
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
    },
  };
}
