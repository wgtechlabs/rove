import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  githubClient,
  shaSchema,
  tagSchema,
  type VerifiedRelease,
} from './aip-release.js';
import { HttpError } from './auth.js';
import { mcpURL } from './mcp.js';
import {
  type PluginPackage,
  parsePackage,
  pluginId,
  repositoryName,
} from './plugin-manifest.js';

export const agentFormat = z.enum(['claude-code', 'cursor', 'codex-skill']);
const paths = z.union([z.string(), z.array(z.string()).max(8)]);
const variable = z
  .object({
    type: z.literal('string'),
    title: z.string().max(80).optional(),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    sensitive: z.boolean().optional(),
  })
  .strict();
const metadata = z
  .object({
    name: pluginId,
    displayName: z.string().max(80).optional(),
    version: z.string().optional(),
    description: z.string().max(500).default(''),
    author: z
      .object({
        name: z.string(),
        email: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    logo: z.string().optional(),
    skills: paths.optional(),
    rules: paths.optional(),
    mcpServers: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional(),
    userConfig: z.record(z.string(), variable).optional(),
    variables: z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), variable),
        required: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const remoteServer = z
  .object({
    type: z.literal('http').optional(),
    url: z.string().max(500),
    headers: z
      .object({ Authorization: z.string().max(200) })
      .strict()
      .optional(),
  })
  .strict();
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
function unsupported(message: string): never {
  throw new HttpError(400, `Unsupported Agent Plugin: ${message}`);
}
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) unsupported(message);
  return result.data;
}
function relative(value: string, root = false): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (root && (path === '.' || path === '')) return '';
  if (
    path.length > 240 ||
    !path
      .split('/')
      .every(
        (part) =>
          /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..',
      )
  )
    unsupported('component paths must stay within the released repository.');
  return path;
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return unsupported('a configuration file is not valid JSON.');
  }
}

/** Deliberately small YAML subset; unsupported metadata fails rather than changing host semantics. */
function frontmatter(text: string, allowed: string[]) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match?.[1] || !match[2]?.trim())
    unsupported('skills and rules need frontmatter and nonempty Markdown.');
  const fields: Record<string, string> = Object.create(null);
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!line.trim() || line.startsWith('#')) continue;
    const pair = /^([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/.exec(line);
    const key = pair?.[1];
    let value = pair?.[2] ?? '';
    if (!key || !allowed.includes(key) || Object.hasOwn(fields, key))
      unsupported('frontmatter supports only the documented scalar fields.');
    if (['>', '|', '>-', '|-'].includes(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1] ?? ''))
        block.push((lines[++index] ?? '').trim());
      value = block.join(value.startsWith('>') ? ' ' : '\n');
    } else if (value.startsWith('"')) {
      const decoded = json(value);
      if (typeof decoded !== 'string')
        unsupported('frontmatter values must be strings.');
      value = decoded;
    } else if (value.startsWith("'")) {
      if (!value.endsWith("'"))
        unsupported('frontmatter has an unterminated quote.');
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (!value || /^[!&*[\]{}]/.test(value) || /\s#|:\s/.test(value))
      unsupported(
        'complex YAML requires conversion to plain scalar frontmatter.',
      );
    fields[key] = value;
  }
  return { fields, body: match[2] };
}

/** Import released declarative source; no third-party code or host configuration is executed. */
export async function importAgentRelease(
  input: {
    repo: string;
    tag: string;
    format: z.infer<typeof agentFormat>;
    token?: string;
    signal?: AbortSignal;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedRelease> {
  const repo = parse(repositoryName, input.repo, 'invalid GitHub repository.');
  const tag = parse(tagSchema, input.tag, 'invalid release tag.');
  const format = parse(agentFormat, input.format, 'unknown source format.');
  const signal = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const github = githubClient(repo, input.token, signal, fetchImpl);
  const release = parse(
    z.object({
      id: z.number().int().positive(),
      tag_name: z.literal(tag),
      draft: z.literal(false),
      prerelease: z.literal(false),
    }),
    await github.object(`/releases/tags/${encodeURIComponent(tag)}`),
    'a published stable GitHub release is required.',
  );
  const reference = z.object({
    object: z.object({ type: z.enum(['tag', 'commit']), sha: shaSchema }),
  });
  let ref = parse(
    reference,
    await github.object(`/git/ref/tags/${encodeURIComponent(tag)}`),
    'the tag cannot be resolved.',
  ).object;
  for (let depth = 0; ref.type === 'tag' && depth < 5; depth++)
    ref = parse(
      reference,
      await github.object(`/git/tags/${ref.sha}`),
      'invalid annotated tag.',
    ).object;
  if (ref.type !== 'commit') unsupported('tag nesting exceeds five levels.');
  const commit = ref.sha;
  const treeSha = parse(
    z.object({ tree: z.object({ sha: shaSchema }) }),
    await github.object(`/git/commits/${commit}`),
    'missing release commit tree.',
  ).tree.sha;
  const tree = parse(
    z.object({
      truncated: z.literal(false),
      tree: z
        .array(
          z.object({
            path: z.string(),
            type: z.enum(['blob', 'tree']),
            mode: z.enum(['100644', '040000']),
            sha: shaSchema,
            size: z.number().int().nonnegative().optional(),
          }),
        )
        .max(500),
    }),
    await github.object(`/git/trees/${treeSha}?recursive=1`),
    'the release must have at most 500 regular files/directories and no symlinks, submodules or executable files.',
  );
  for (const entry of tree.tree) relative(entry.path);
  const files = new Map(
    tree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => [entry.path, entry]),
  );
  if (files.size !== tree.tree.filter((entry) => entry.type === 'blob').length)
    unsupported('duplicate source paths.');
  const consumed = new Map<string, { text: string; digest: string }>();
  let totalBytes = 0;
  async function read(path: string) {
    const safe = relative(path);
    const prior = consumed.get(safe);
    if (prior) return prior.text;
    const entry = files.get(safe);
    if (
      !entry ||
      entry.size === undefined ||
      entry.size > 32000 ||
      consumed.size >= 24
    )
      unsupported(
        'a component is missing or exceeds the 24-file/32-KB per-file import limit.',
      );
    const blob = parse(
      z.object({
        encoding: z.literal('base64'),
        content: z.string(),
        sha: z.literal(entry.sha),
        size: z.literal(entry.size),
      }),
      await github.object(`/git/blobs/${entry.sha}`),
      'invalid source blob.',
    );
    const bytes = Buffer.from(blob.content, 'base64');
    totalBytes += bytes.byteLength;
    if (
      bytes.byteLength !== entry.size ||
      totalBytes > 128000 ||
      createHash('sha1')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex') !== entry.sha
    )
      unsupported('source integrity or total 128-KB import limit failed.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return unsupported('only UTF-8 components are supported.');
    }
    consumed.set(safe, {
      text,
      digest: createHash('sha256').update(bytes).digest('hex'),
    });
    return text;
  }
  for (const path of files.keys())
    if (
      /^(?:hooks|commands|agents|output-styles|workflows|monitors|scripts|references)\/|^(?:\.lsp\.json|settings\.json)$/.test(
        path,
      )
    )
      unsupported(
        'hooks, commands, agents, dependency metadata and local execution are not imported.',
      );

  let manifest: z.infer<typeof metadata> | undefined;
  if (format !== 'codex-skill') {
    manifest = parse(
      metadata,
      json(
        await read(
          format === 'claude-code'
            ? '.claude-plugin/plugin.json'
            : '.cursor-plugin/plugin.json',
        ),
      ),
      'manifest fields include unsupported behavior.',
    );
    if (
      format === 'claude-code' &&
      (manifest.rules || manifest.variables || manifest.logo)
    )
      unsupported(
        'Cursor-only manifest fields were found in a Claude Code plugin.',
      );
    if (format === 'cursor' && manifest.userConfig)
      unsupported(
        'Claude Code configuration fields were found in a Cursor plugin.',
      );
  }
  const skills: PluginPackage['skills'] = [];
  const declaredRoots =
    manifest?.skills === undefined
      ? []
      : (Array.isArray(manifest.skills)
          ? manifest.skills
          : [manifest.skills]
        ).map((path) => relative(path, true));
  const roots =
    manifest?.skills === undefined ? ['skills'] : [...declaredRoots];
  if (format === 'claude-code' && !roots.includes('skills'))
    roots.unshift('skills');
  const skillFiles =
    format === 'codex-skill'
      ? [...files.keys()].filter(
          (path) =>
            path === 'SKILL.md' ||
            /^\.agents\/skills\/[^/]+\/SKILL\.md$/.test(path),
        )
      : [...files.keys()].filter((path) =>
          roots.some(
            (root) =>
              path === `${root ? `${root}/` : ''}SKILL.md` ||
              (path.startsWith(`${root ? `${root}/` : ''}`) &&
                path.slice(root ? root.length + 1 : 0).split('/').length ===
                  2 &&
                path.endsWith('/SKILL.md')),
          ),
        );
  if (
    format === 'cursor' &&
    manifest?.skills === undefined &&
    !skillFiles.length &&
    !tree.tree.some((entry) => entry.path === 'skills') &&
    files.has('SKILL.md')
  )
    skillFiles.push('SKILL.md');
  if (skillFiles.length > 8 || (format === 'codex-skill' && !skillFiles.length))
    unsupported('select a release containing one to eight standalone skills.');
  if (
    manifest?.skills !== undefined &&
    declaredRoots.some(
      (root) =>
        !skillFiles.some((file) => file.startsWith(root ? `${root}/` : '')),
    )
  )
    unsupported('a declared skill directory has no supported skill.');
  for (const path of skillFiles.sort()) {
    const text = await read(path);
    const { fields } = frontmatter(text, [
      'name',
      'description',
      'license',
      'compatibility',
    ]);
    const name = parse(
      pluginId,
      fields.name,
      'skill names must be lowercase kebab-case.',
    );
    if (!fields.description || fields.description.length > 500)
      unsupported(
        'skill descriptions are required and must fit 500 characters.',
      );
    if (/!`|\$\{/.test(text))
      unsupported(
        'skill shell substitution and host variable expansion are unavailable.',
      );
    const directory =
      path === 'SKILL.md' ? '' : path.slice(0, -'SKILL.md'.length);
    if (
      [...files.keys()].some(
        (file) =>
          file !== path &&
          file.startsWith(directory) &&
          (directory || /^(scripts|references|assets|agents)\//.test(file)),
      )
    )
      unsupported(
        'skill resources and scripts require conversion to self-contained Markdown.',
      );
    skills.push({ name, markdown: text });
  }
  let instructions = '';
  if (format === 'cursor') {
    const ruleRoots =
      manifest?.rules === undefined
        ? ['rules']
        : (Array.isArray(manifest.rules)
            ? manifest.rules
            : [manifest.rules]
          ).map((path) => relative(path));
    const rules = [...files.keys()].filter((path) =>
      ruleRoots.some((root) => path === root || path.startsWith(`${root}/`)),
    );
    if (
      rules.length > 8 ||
      (manifest?.rules !== undefined &&
        ruleRoots.some(
          (root) =>
            !rules.some((path) => path === root || path.startsWith(`${root}/`)),
        ))
    )
      unsupported('rule paths must name one to eight Markdown files.');
    for (const path of rules.sort()) {
      if (!/\.(md|mdc|markdown)$/.test(path))
        unsupported('rule directories may contain only Markdown.');
      const { fields, body } = frontmatter(await read(path), [
        'description',
        'alwaysApply',
      ]);
      if (fields.alwaysApply !== 'true')
        unsupported(
          'conditional or glob-scoped Cursor rules cannot become global Rove instructions.',
        );
      if (/!`|\$\{/.test(body))
        unsupported(
          'rule shell substitution and host variable expansion are unavailable.',
        );
      instructions += `\n\n${body}`;
    }
  }
  const declarations = new Map<string, string>();
  for (const [key, value] of Object.entries(
    manifest?.userConfig ?? manifest?.variables?.properties ?? {},
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      unsupported('invalid configuration variable name.');
    declarations.set(key, value.title ?? key);
  }
  const usedDeclarations = new Set<string>();
  const servers: PluginPackage['servers'] = [];
  const secrets: PluginPackage['secrets'] = [];
  const configs: unknown[] = [];
  const defaultMcp = format === 'claude-code' ? '.mcp.json' : 'mcp.json';
  if (
    format !== 'codex-skill' &&
    files.has(defaultMcp) &&
    (format === 'claude-code' || manifest?.mcpServers === undefined)
  )
    configs.push(json(await read(defaultMcp)));
  if (manifest?.mcpServers !== undefined)
    configs.push(
      typeof manifest.mcpServers === 'string'
        ? json(await read(relative(manifest.mcpServers)))
        : { mcpServers: manifest.mcpServers },
    );
  for (const config of configs) {
    const entries = parse(
      z.object({ mcpServers: z.record(z.string(), remoteServer) }).strict(),
      config,
      'only remote HTTP MCP with an optional bearer-token placeholder is supported.',
    ).mcpServers;
    for (const [id, server] of Object.entries(entries)) {
      parse(pluginId, id, 'MCP server names must be lowercase kebab-case.');
      if (servers.some((existing) => existing.id === id))
        unsupported('duplicate MCP server names across configuration files.');
      if (server.url.includes('${'))
        unsupported('MCP endpoint interpolation is unsupported.');
      const url = mcpURL(server.url, 'https://rove.invalid');
      let secret: string | undefined;
      if (server.headers) {
        const match =
          /^Bearer \$\{(user_config\.)?([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(
            server.headers.Authorization,
          );
        const key = match?.[2];
        if (
          !key ||
          (format === 'cursor' && match?.[1]) ||
          ((format === 'cursor' || match?.[1]) && !declarations.has(key))
        )
          unsupported(
            'bearer tokens must reference a declared configuration value; literal secrets are rejected.',
          );
        usedDeclarations.add(key);
        secret = `token-${sha256(key).slice(0, 16)}`;
        if (!secrets.some((entry) => entry.key === secret))
          secrets.push({
            key: secret,
            label: declarations.get(key) ?? key,
            required: true,
          });
      }
      servers.push({ id, name: id, url, ...(secret ? { secret } : {}) });
    }
  }
  if ([...declarations.keys()].some((key) => !usedDeclarations.has(key)))
    unsupported(
      'configuration values outside MCP bearer-token bindings are not imported.',
    );
  if (
    format === 'codex-skill' &&
    [...files.keys()].some((path) =>
      /(?:^|\/)(?:mcp\.json|\.mcp\.json|openai\.yaml)$/.test(path),
    )
  )
    unsupported(
      'Codex tool dependency metadata must be configured manually in Rove.',
    );
  const pkg = parsePackage({
    schemaVersion: 1,
    apiVersion: 1,
    id:
      manifest?.name ??
      (skills.length === 1 ? skills[0]?.name : repo.split('/')[1]),
    name:
      manifest?.displayName ??
      manifest?.name ??
      (skills.length === 1 ? skills[0]?.name : repo.split('/')[1]),
    version: manifest?.version ?? tag.replace(/^v/, ''),
    category: 'agent',
    description: manifest?.description ?? 'Imported standalone agent skills.',
    skills,
    instructions: instructions.trim(),
    servers,
    secrets,
    capabilities: servers.map((server) => `mcp:${server.id}`),
  });
  if (!pkg.skills.length && !pkg.instructions && !pkg.servers.length)
    unsupported('no supported content was found.');
  const notices: Array<{ path: string; text: string }> = [];
  for (const path of [
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'COPYING',
    'NOTICE',
    'NOTICE.md',
  ]) {
    if (files.has(path)) notices.push({ path, text: await read(path) });
  }
  const bytes = `${JSON.stringify(pkg)}\n`;
  const evidence = [...consumed]
    .map(([path, source]) => ({ path, digest: source.digest }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    repo,
    tag,
    commit,
    digest: sha256(bytes),
    assetId: null,
    manifest: pkg,
    bytes,
    origin: {
      format,
      releaseId: release.id,
      sourceDigest: sha256(JSON.stringify(evidence)),
      files: evidence,
      metadata: {
        ...(manifest?.license ? { license: manifest.license } : {}),
        ...(manifest?.author ? { author: manifest.author } : {}),
        ...(manifest?.homepage ? { homepage: manifest.homepage } : {}),
        ...(manifest?.repository ? { repository: manifest.repository } : {}),
        ...(notices.length ? { notices } : {}),
      },
    },
  };
}
