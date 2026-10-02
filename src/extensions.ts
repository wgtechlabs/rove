import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Tool } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import { mcpURL, validateTool, withMcp } from './mcp.js';
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

export function createExtensions(config: Config) {
  const secrets = createSecrets(config.authSecret);
  const db = new DatabaseSync(config.databasePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rove_extension (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, revision TEXT NOT NULL,
        credential TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS rove_extension_owner (id TEXT PRIMARY KEY, installation TEXT NOT NULL);`);
  } catch (error) {
    db.close();
    throw error;
  }
  const lifetime = new AbortController();
  let closed = false;
  let executing = false;
  function records(): Stored[] {
    if (closed) throw new HttpError(503, 'Extensions are shutting down.');
    return db
      .prepare(
        'SELECT e.*, o.installation FROM rove_extension e LEFT JOIN rove_extension_owner o ON e.id=o.id ORDER BY e.id',
      )
      .all()
      .map((row) => ({
        id: String(row.id),
        entry: input.parse(JSON.parse(String(row.data))),
        revision: String(row.revision),
        credential: String(row.credential),
        tools: JSON.parse(String(row.tools)) as Tool[],
        ...(row.installation ? { managedBy: String(row.installation) } : {}),
      }));
  }
  function revision(rows = records()) {
    return digest(JSON.stringify(rows.map((row) => [row.id, row.revision])));
  }
  function list() {
    const rows = records();
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
  function save(body: unknown, allowNewId = false) {
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
    const rows = records();
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
    db.prepare(`INSERT INTO rove_extension(id,data,revision,credential,tools) VALUES(?,?,?,?,'[]')
      ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision,credential=excluded.credential,tools='[]'`).run(
      id,
      JSON.stringify(entry),
      randomUUID(),
      credential,
    );
    return list();
  }
  function instructions() {
    return records()
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
    const row = records().find((record) => record.id === id);
    if (row?.entry.kind !== 'server')
      throw new HttpError(404, 'MCP server not found.');
    const token = row.credential ? secrets.decrypt(row.credential) : '';
    const current = randomUUID();
    db.prepare(
      "UPDATE rove_extension SET tools='[]',revision=? WHERE id=?",
    ).run(current, id);
    const tools = await discoverTools(
      row.entry.url,
      token,
      config.baseURL,
      AbortSignal.any([signal, lifetime.signal]),
    );
    if (lifetime.signal.aborted)
      throw new HttpError(503, 'Extensions are shutting down.');
    const changed = db
      .prepare('UPDATE rove_extension SET tools=? WHERE id=? AND revision=?')
      .run(JSON.stringify(tools), id, current);
    if (!changed.changes)
      throw new HttpError(
        409,
        'The MCP configuration changed. Probe it again.',
      );
    return list();
  }
  async function tools(signal: AbortSignal): Promise<ExtensionTool[]> {
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const rows = records();
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
    const row = records().find((item) =>
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
    if (executing)
      throw new HttpError(409, 'Another MCP tool is already running.');
    executing = true;
    return withMcp(
      row.entry.url,
      token,
      config.baseURL,
      AbortSignal.any([signal, lifetime.signal]),
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
  // All managed content and its active release pointer commit on one SQLite connection.
  function replaceManaged(
    owner: string,
    entries: ManagedExtension[],
    commit: (db: DatabaseSync) => void,
  ) {
    if (executing)
      throw new HttpError(
        409,
        'Wait for the current tool call before changing active plugins.',
      );
    const existing = records();
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
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'DELETE FROM rove_extension WHERE id IN (SELECT id FROM rove_extension_owner WHERE installation=?)',
      ).run(owner);
      db.prepare('DELETE FROM rove_extension_owner WHERE installation=?').run(
        owner,
      );
      for (const row of entries) {
        db.prepare('INSERT INTO rove_extension VALUES(?,?,?,?,?)').run(
          row.id,
          JSON.stringify(row.entry),
          randomUUID(),
          row.credential,
          JSON.stringify(row.tools),
        );
        db.prepare('INSERT INTO rove_extension_owner VALUES(?,?)').run(
          row.id,
          owner,
        );
      }
      commit(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function deactivateManaged(
    owner: string | string[],
    commit: (db: DatabaseSync) => void,
  ) {
    // Revocation blocks future dispatch even while a previously dispatched request completes.
    const owners = Array.isArray(owner) ? owner : [owner];
    const owned = records().filter(
      (row) => row.managedBy && owners.includes(row.managedBy),
    );
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of owned)
        db.prepare(
          'UPDATE rove_extension SET data=?,revision=? WHERE id=?',
        ).run(
          JSON.stringify({ ...row.entry, enabled: false }),
          randomUUID(),
          row.id,
        );
      commit(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    list,
    replaceManaged,
    deactivateManaged,
    save: (body: unknown) => save(body),
    adoptSkill(body: {
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
      return save(
        {
          kind: 'skill',
          id: parsed.data.id,
          name: parsed.data.name,
          markdown: parsed.data.content,
          enabled: parsed.data.enabled,
        },
        true,
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
      db.close();
    },
  };
}
