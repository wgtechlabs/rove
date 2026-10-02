import { createHash, randomUUID } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { HttpError } from './auth.js';
import type { Sql } from './database.js';
import { mcpURL, validateTool, withMcp } from './mcp.js';
import type { RuntimeConfig } from './runtime.js';
import { createSecrets } from './secrets.js';

const name = z.string().trim().min(1).max(80);
const skill = z
  .object({ name, markdown: z.string().min(1).max(8000) })
  .strict();
const common = { id: z.uuid().optional(), name, enabled: z.boolean() };
const input = z.discriminatedUnion('kind', [
  z
    .object({
      ...common,
      kind: z.literal('skill'),
      markdown: skill.shape.markdown,
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('plugin'),
      skills: z.array(skill).min(1).max(8),
    })
    .strict(),
  z
    .object({
      ...common,
      kind: z.literal('server'),
      url: z.string().min(1).max(500),
      bearerToken: z.string().trim().max(2000).optional(),
      clearToken: z.boolean().optional(),
    })
    .strict(),
]);
export type Entry = z.infer<typeof input>;
type Stored = {
  id: string;
  entry: Entry;
  revision: string;
  credential: string;
  tools: Tool[];
  managedBy?: string;
};
export type ManagedExtension = Pick<
  Stored,
  'id' | 'entry' | 'credential' | 'tools'
>;
export interface ExtensionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  revision: string;
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const alias = (id: string, tool: string) =>
  `mcp_${id.replaceAll('-', '')}_${digest(tool).slice(0, 16)}`;
const definition = (tool: Tool) => ({
  name: tool.name,
  description: tool.description || '',
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
});
const markdown = (entry: Entry) =>
  entry.kind === 'skill'
    ? [entry]
    : entry.kind === 'plugin'
      ? entry.skills
      : [];

export async function discoverTools(
  url: string,
  token: string,
  baseURL: string,
  signal: AbortSignal,
) {
  return withMcp(url, token, baseURL, signal, async (client, options) => {
    const result = await client.listTools(undefined, options);
    if (
      result.tools.length > 32 ||
      new Set(result.tools.map((tool) => tool.name)).size !==
        result.tools.length
    )
      throw new HttpError(
        502,
        'MCP catalogs need at most 32 uniquely named tools.',
      );
    for (const tool of result.tools) validateTool(tool);
    if (Buffer.byteLength(JSON.stringify(result.tools)) > 64000)
      throw new HttpError(502, 'The MCP tool catalog is too large.');
    return result.tools.map(definition);
  });
}

export async function createExtensions(config: RuntimeConfig) {
  const secrets = createSecrets(config.authSecret);
  const db = config.db;
  await db.migrate(`
    CREATE TABLE IF NOT EXISTS rove_extension (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, revision TEXT NOT NULL,
      credential TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS rove_extension_owner (id TEXT PRIMARY KEY, installation TEXT NOT NULL);`);
  const lifetime = new AbortController();
  const shutdown = AbortSignal.any([lifetime.signal, config.state.signal]);
  let closed = false;
  let executing = false;
  let changing = false;
  async function change<T>(action: () => Promise<T>) {
    if (changing)
      throw new HttpError(
        409,
        'Another extension change is running. Try again shortly.',
      );
    changing = true;
    try {
      return await action();
    } finally {
      changing = false;
    }
  }
  async function records(): Promise<Stored[]> {
    if (closed) throw new HttpError(503, 'Extensions are shutting down.');
    return (
      await db.all(
        'SELECT e.*, o.installation FROM rove_extension e LEFT JOIN rove_extension_owner o ON e.id=o.id ORDER BY e.id',
        [],
      )
    ).map((row) => ({
      id: String(row.id),
      entry: input.parse(JSON.parse(String(row.data))),
      revision: String(row.revision),
      credential: String(row.credential),
      tools: JSON.parse(String(row.tools)) as Tool[],
      ...(row.installation ? { managedBy: String(row.installation) } : {}),
    }));
  }
  function revision(rows: Stored[]) {
    return digest(JSON.stringify(rows.map((row) => [row.id, row.revision])));
  }
  async function list() {
    const rows = await records();
    return {
      skills: rows.flatMap((row) =>
        row.entry.kind === 'skill'
          ? [
              {
                ...row.entry,
                id: row.id,
                revision: row.revision,
                managedBy: row.managedBy,
              },
            ]
          : [],
      ),
      plugins: rows.flatMap((row) =>
        row.entry.kind === 'plugin'
          ? [
              {
                ...row.entry,
                id: row.id,
                revision: row.revision,
                managedBy: row.managedBy,
              },
            ]
          : [],
      ),
      servers: rows.flatMap((row) =>
        row.entry.kind === 'server'
          ? [
              {
                kind: 'server' as const,
                id: row.id,
                name: row.entry.name,
                url: row.entry.url,
                enabled: row.entry.enabled,
                revision: row.revision,
                managedBy: row.managedBy,
                configured: Boolean(row.credential),
                tools: row.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description || '',
                })),
              },
            ]
          : [],
      ),
    };
  }
  async function save(body: unknown, allowNewId = false) {
    if (executing)
      throw new HttpError(
        409,
        'Wait for the current tool call before editing extensions.',
      );
    const parsed = input.safeParse(body);
    if (!parsed.success)
      throw new HttpError(
        400,
        'Enter a valid skill, declarative plugin or MCP server configuration.',
      );
    const entry = parsed.data;
    const rows = await records();
    const existing = entry.id
      ? rows.find((row) => row.id === entry.id)
      : undefined;
    if (existing?.managedBy)
      throw new HttpError(
        409,
        'Manage released content from its plugin installation.',
      );
    if (entry.id && !existing && !allowNewId)
      throw new HttpError(404, 'Extension not found.');
    if (existing && existing.entry.kind !== entry.kind)
      throw new HttpError(400, 'An extension cannot change kind.');
    if (!existing && rows.length >= 32)
      throw new HttpError(409, 'This preview supports up to 32 extensions.');
    let credential = existing?.credential || '';
    if (entry.kind === 'server') {
      entry.url = mcpURL(entry.url, config.baseURL);
      if (
        !existing &&
        rows.filter((row) => row.entry.kind === 'server').length >= 8
      )
        throw new HttpError(
          409,
          'This preview supports up to eight MCP servers.',
        );
      if (/[\r\n]/.test(entry.bearerToken || ''))
        throw new HttpError(400, 'Enter a valid bearer credential.');
      if (entry.clearToken && entry.bearerToken)
        throw new HttpError(
          400,
          'Choose a replacement credential or clear the saved credential.',
        );
      if (entry.clearToken) credential = '';
      else if (entry.bearerToken)
        credential = secrets.encrypt(entry.bearerToken);
      else if (
        credential &&
        existing?.entry.kind === 'server' &&
        existing.entry.url !== entry.url
      )
        throw new HttpError(
          400,
          'Changing the MCP endpoint requires a new credential or clearing the saved credential.',
        );
      delete entry.bearerToken;
      delete entry.clearToken;
    }
    const total = [
      ...rows.filter((row) => row.id !== existing?.id).map((row) => row.entry),
      entry,
    ]
      .flatMap(markdown)
      .reduce((sum, item) => sum + item.markdown.length, 0);
    if (total > 24_000)
      throw new HttpError(
        400,
        'Keep all saved skill instructions within 24,000 characters.',
      );
    const id = existing?.id || entry.id || randomUUID();
    await db.run(
      `INSERT INTO rove_extension(id,data,revision,credential,tools) VALUES($1,$2,$3,$4,'[]')
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,credential=excluded.credential,tools='[]'`,
      [id, JSON.stringify(entry), randomUUID(), credential],
    );
    return await list();
  }
  async function instructions() {
    return (await records())
      .filter((row) => row.entry.enabled)
      .flatMap((row) =>
        markdown(row.entry).map((item) => `### ${item.name}\n${item.markdown}`),
      )
      .join('\n\n');
  }
  async function probe(id: string, signal: AbortSignal) {
    if (executing)
      throw new HttpError(
        409,
        'Wait for the current tool call before probing extensions.',
      );
    const row = (await records()).find((record) => record.id === id);
    if (row?.entry.kind !== 'server')
      throw new HttpError(404, 'MCP server not found.');
    const token = row.credential ? secrets.decrypt(row.credential) : '';
    const current = randomUUID();
    const invalidated = await change(() =>
      db.run(
        "UPDATE rove_extension SET tools='[]',revision=$1 WHERE id=$2 AND revision=$3",
        [current, id, row.revision],
      ),
    );
    if (!invalidated)
      throw new HttpError(
        409,
        'The MCP configuration changed. Probe it again.',
      );
    const tools = await discoverTools(
      row.entry.url,
      token,
      config.baseURL,
      AbortSignal.any([signal, shutdown]),
    );
    if (shutdown.aborted)
      throw new HttpError(503, 'Extensions are shutting down.');
    const changed = await db.run(
      'UPDATE rove_extension SET tools=$1 WHERE id=$2 AND revision=$3',
      [JSON.stringify(tools), id, current],
    );
    if (!changed)
      throw new HttpError(
        409,
        'The MCP configuration changed. Probe it again.',
      );
    return await list();
  }
  async function tools(signal: AbortSignal): Promise<ExtensionTool[]> {
    signal.throwIfAborted();
    shutdown.throwIfAborted();
    const rows = await records();
    const current = revision(rows);
    const result = rows.flatMap((row) =>
      row.entry.kind === 'server' && row.entry.enabled
        ? row.tools.map((tool) => ({
            name: alias(row.id, tool.name),
            description: `${row.entry.name}: ${tool.description || tool.name}`,
            parameters: tool.inputSchema,
            revision: digest(`${current}:${row.id}:${JSON.stringify(tool)}`),
          }))
        : [],
    );
    if (result.length > 32)
      throw new HttpError(
        409,
        'Enable at most 32 MCP tools across all servers.',
      );
    return result;
  }
  async function execute(
    name: string,
    args: Record<string, unknown>,
    approvedRevision: string,
    signal: AbortSignal,
  ) {
    const tool = (await tools(signal)).find((item) => item.name === name);
    if (!tool) throw new HttpError(409, 'This tool is no longer enabled.');
    if (tool.revision !== approvedRevision)
      throw new HttpError(
        409,
        'The extension configuration changed. Request a new approval.',
      );
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > 16_000
    )
      throw new HttpError(
        400,
        'Tool arguments must be a JSON object within 16 KB.',
      );
    const row = (await records()).find((item) =>
      item.tools.some((itemTool) => alias(item.id, itemTool.name) === name),
    );
    const original = row?.tools.find(
      (item) => alias(row.id, item.name) === name,
    );
    if (row?.entry.kind !== 'server' || !original)
      throw new HttpError(409, 'The MCP tool is unavailable.');
    const checked = await validateTool(original)['~standard'].validate(args);
    if (checked.issues)
      throw new HttpError(
        400,
        'The tool arguments do not match its input schema.',
      );
    const token = row.credential ? secrets.decrypt(row.credential) : '';
    if (executing || changing)
      throw new HttpError(
        409,
        'Another MCP tool or extension change is running.',
      );
    executing = true;
    return withMcp(
      row.entry.url,
      token,
      config.baseURL,
      AbortSignal.any([signal, shutdown]),
      async (client, options) => {
        const fresh = await client.listTools(undefined, options);
        const remote = fresh.tools.find((item) => item.name === original.name);
        if (
          !remote ||
          JSON.stringify(definition(remote)) !== JSON.stringify(original)
        )
          throw new HttpError(
            409,
            'The remote tool changed. Probe the server and request a new approval.',
          );
        if (
          changing ||
          (await tools(signal)).find((item) => item.name === name)?.revision !==
            approvedRevision
        )
          throw new HttpError(
            409,
            'The extension configuration changed. Request a new approval.',
          );
        const result = await client.callTool(
          { name: original.name, arguments: args },
          options,
        );
        if (result.isError)
          throw new HttpError(
            502,
            'The MCP tool reported an error. Its remote outcome may be unknown.',
          );
        const content = result.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        const output =
          result.structuredContent === undefined
            ? content
            : `${content}\n${JSON.stringify(result.structuredContent)}`;
        if (!output.trim())
          throw new HttpError(
            502,
            'This preview supports MCP text and JSON results only.',
          );
        if (Buffer.byteLength(output) > 16_000)
          throw new HttpError(
            502,
            'The MCP result exceeds 16 KB. Its remote action may already be complete.',
          );
        return output;
      },
    ).finally(() => {
      executing = false;
    });
  }
  // Managed content and its active release pointer commit in one transaction.
  async function replaceManaged(
    owner: string,
    entries: ManagedExtension[],
    commit: (db: Sql) => Promise<void>,
  ) {
    if (executing)
      throw new HttpError(
        409,
        'Wait for the current tool call before changing active plugins.',
      );
    const existing = await records();
    const remaining = existing.filter((row) => row.managedBy !== owner);
    for (const row of entries) {
      if (!input.safeParse(row.entry).success)
        throw new HttpError(
          400,
          'A configured plugin contribution exceeds the supported field limits. Shorten its settings or instructions.',
        );
      if (remaining.some((item) => item.id === row.id))
        throw new HttpError(409, 'Plugin contribution ID is already in use.');
    }
    const all = [...remaining, ...entries];
    if (
      all.length > 32 ||
      all.filter((row) => row.entry.kind === 'server').length > 8 ||
      all
        .flatMap((row) => markdown(row.entry))
        .reduce((sum, item) => sum + item.markdown.length, 0) > 24000 ||
      all
        .filter((row) => row.entry.enabled)
        .reduce((sum, row) => sum + row.tools.length, 0) > 32
    )
      throw new HttpError(
        409,
        'Plugin activation exceeds the shared extension limits.',
      );
    await db.transaction(async (tx) => {
      await tx.run(
        'DELETE FROM rove_extension WHERE id IN (SELECT id FROM rove_extension_owner WHERE installation=$1)',
        [owner],
      );
      await tx.run('DELETE FROM rove_extension_owner WHERE installation=$1', [
        owner,
      ]);
      for (const row of entries) {
        await tx.run('INSERT INTO rove_extension VALUES($1,$2,$3,$4,$5)', [
          row.id,
          JSON.stringify(row.entry),
          randomUUID(),
          row.credential,
          JSON.stringify(row.tools),
        ]);
        await tx.run('INSERT INTO rove_extension_owner VALUES($1,$2)', [
          row.id,
          owner,
        ]);
      }
      await commit(tx);
    });
  }
  async function deactivateManaged(
    owner: string | string[],
    commit: (db: Sql) => Promise<void>,
  ) {
    // Revocation blocks future dispatch even while a previously dispatched request completes.
    const owners = Array.isArray(owner) ? owner : [owner];
    const owned = (await records()).filter(
      (row) => row.managedBy && owners.includes(row.managedBy),
    );
    await db.transaction(async (tx) => {
      for (const row of owned)
        await tx.run(
          'UPDATE rove_extension SET data=$1,revision=$2 WHERE id=$3',
          [
            JSON.stringify({ ...row.entry, enabled: false }),
            randomUUID(),
            row.id,
          ],
        );
      await commit(tx);
    });
  }
  return {
    list,
    replaceManaged: (...args: Parameters<typeof replaceManaged>) =>
      change(() => replaceManaged(...args)),
    deactivateManaged: (...args: Parameters<typeof deactivateManaged>) =>
      change(() => deactivateManaged(...args)),
    save: (body: unknown) => change(() => save(body)),
    async adoptSkill(body: {
      id: string;
      name: string;
      content: string;
      enabled: boolean;
    }) {
      const parsed = z
        .object({
          id: z.uuid(),
          name,
          content: skill.shape.markdown,
          enabled: z.boolean(),
        })
        .strict()
        .safeParse(body);
      if (!parsed.success)
        throw new HttpError(400, 'Enter a valid adopted skill.');
      return change(() =>
        save(
          {
            kind: 'skill',
            id: parsed.data.id,
            name: parsed.data.name,
            markdown: parsed.data.content,
            enabled: parsed.data.enabled,
          },
          true,
        ),
      );
    },
    tools,
    execute,
    probe,
    instructions,
    close() {
      if (closed) return;
      lifetime.abort();
      closed = true;
    },
  };
}
