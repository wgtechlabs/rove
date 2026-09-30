import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import { createSecrets } from './secrets.js';

const proposal = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(500),
    bullets: z.array(z.string().trim().min(1).max(500)).min(1).max(7),
    skillName: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(80),
    skillContent: z
      .string()
      .min(1)
      .max(8000)
      .refine((value) => Boolean(value.trim())),
    rationale: z.string().trim().min(1).max(2000),
    validation: z.string().trim().min(1).max(2000),
  })
  .strict();
const stageInput = z.discriminatedUnion('action', [
  proposal.extend({ action: z.literal('draft') }),
  proposal.extend({ action: z.literal('revise'), id: z.uuid() }),
  z.object({ action: z.literal('cancel'), id: z.uuid() }).strict(),
]);
const targetInput = z.object({ id: z.uuid() }).strict();
const settingsInput = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? '')),
    token: z.string().trim().max(1000).optional(),
  })
  .strict();

type Proposal = z.infer<typeof proposal>;
type Status =
  | 'draft'
  | 'cancelled'
  | 'publishing'
  | 'uncertain'
  | 'published'
  | 'adopting'
  | 'adopted';
interface Aip extends Proposal {
  id: string;
  scope: string;
  version: number;
  status: Status;
  updatedAt: number;
  repo?: string;
  branch?: string;
  number?: number;
  url?: string;
  mergeCommit?: string;
}
export interface AdoptedSkill {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      'Invalid AIP fields. Check the proposed content and try again.',
    );
  return result.data;
}

/** Persist source-scoped proposals; approved calls publish draft PRs or adopt verified merged skills. */
export function createAips(
  config: Config,
  onAdopt?: (skill: AdoptedSkill) => void | Promise<void>,
  fetchImpl: typeof fetch = fetch,
) {
  const secrets = createSecrets(config.authSecret);
  const db = new DatabaseSync(config.databasePath);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rove_github (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), repo TEXT NOT NULL, token TEXT NOT NULL, version TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rove_aip (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL
      );`);
  } catch (error) {
    db.close();
    throw error;
  }
  // ponytail: one in-flight AIP operation per process; use durable worker leases before multiple replicas.
  let busy = false;
  let closed = false;
  let active: AbortController | undefined;

  function saved() {
    return db.prepare('SELECT * FROM rove_github WHERE singleton=1').get();
  }
  function settings() {
    const row = saved();
    return {
      repo: row ? String(row.repo) : '',
      configured: Boolean(row?.token),
    };
  }
  function saveSettings(body: unknown) {
    if (busy)
      throw new HttpError(
        409,
        'Wait for the active AIP operation before changing GitHub settings.',
      );
    const input = parse(settingsInput, body);
    const existing = saved();
    if (
      /[\r\n]/.test(input.token ?? '') ||
      (!input.token && (!existing?.token || existing.repo !== input.repo))
    ) {
      throw new HttpError(
        400,
        'Enter a GitHub token. Changing the repository requires a new token.',
      );
    }
    db.prepare(`INSERT INTO rove_github VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      repo=excluded.repo, token=excluded.token, version=excluded.version`).run(
      input.repo,
      input.token ? secrets.encrypt(input.token) : String(existing?.token),
      randomUUID(),
    );
    return settings();
  }
  function list(scope: string): Aip[] {
    return db
      .prepare('SELECT data FROM rove_aip WHERE scope=? ORDER BY rowid DESC')
      .all(scope)
      .map((row) => JSON.parse(String(row.data)) as Aip);
  }
  function write(record: Aip) {
    db.prepare(
      'INSERT INTO rove_aip VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
    ).run(record.id, record.scope, JSON.stringify(record));
  }
  function revision(scope: string) {
    return createHash('sha256')
      .update(JSON.stringify([saved()?.version ?? '', list(scope)]))
      .digest('hex');
  }
  function tools(scope: string, _actor?: string) {
    if (!settings().configured) return [];
    const current = revision(scope);
    return [
      {
        name: 'rove_aip_stage',
        description:
          'Draft, revise, or cancel an Agent Improvement Proposal in this conversation. Include the exact proposed reusable skill, rationale, and a reproducible validation check. A draft never changes active behavior. Revisions replace the complete draft and invalidate earlier approval.',
        parameters: {
          type: 'object',
          properties: {
            ...z.toJSONSchema(proposal).properties,
            action: { type: 'string', enum: ['draft', 'revise', 'cancel'] },
            id: { type: 'string', format: 'uuid' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        revision: current,
      },
      {
        name: 'rove_aip_publish',
        description:
          'Publish this conversation’s stored AIP as a GitHub draft pull request containing its exact proposed skill. Never merges or adopts it. Inspect the saved proposal first; approval authorizes this exact stored revision and GitHub destination.',
        parameters: z.toJSONSchema(targetInput),
        revision: current,
      },
      {
        name: 'rove_aip_adopt',
        description:
          'Adopt this conversation’s published AIP only after GitHub confirms its PR merged and the merged file exactly matches the stored skill. Requires a separate administrator approval; creating or merging a PR alone does not activate a skill.',
        parameters: z.toJSONSchema(targetInput),
        revision: current,
      },
    ];
  }
  function get(scope: string, id: string) {
    const record = list(scope).find((item) => item.id === id);
    if (!record)
      throw new HttpError(404, 'AIP not found in this conversation.');
    return record;
  }

  function preview(name: string, args: unknown, scope: string): string {
    if (name === 'rove_aip_stage')
      return JSON.stringify({ tool: name, ...parse(stageInput, args) });
    if (name !== 'rove_aip_publish' && name !== 'rove_aip_adopt')
      throw new HttpError(404, 'Unknown AIP tool.');
    return JSON.stringify({
      action: name,
      destination: settings().repo,
      proposal: get(scope, parse(targetInput, args).id),
    });
  }

  async function execute(
    name: string,
    args: unknown,
    expectedRevision: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (closed) throw new HttpError(503, 'AIP service is stopping.');
    if (busy)
      throw new HttpError(
        409,
        'Another AIP operation is running. Try again after it finishes.',
      );
    if (signal?.aborted)
      throw new HttpError(409, 'The AIP operation was cancelled.');
    if (!settings().configured || expectedRevision !== revision(scope)) {
      throw new HttpError(
        409,
        'The proposal or GitHub settings changed. Review it and approve a new tool call.',
      );
    }
    if (name === 'rove_aip_stage') {
      const input = parse(stageInput, args);
      if (input.action === 'draft') {
        const { action: _action, ...content } = input;
        const existing = list(scope).find(
          (item) =>
            item.status === 'draft' &&
            item.skillName === content.skillName &&
            item.skillContent === content.skillContent,
        );
        if (existing)
          return JSON.stringify({ ...existing, alreadyExists: true });
        if (list(scope).length >= 100)
          throw new HttpError(
            409,
            'This conversation has reached 100 AIPs. Start a new conversation.',
          );
        const record: Aip = {
          ...content,
          id: randomUUID(),
          scope,
          version: 1,
          status: 'draft',
          updatedAt: Date.now(),
        };
        write(record);
        return JSON.stringify(record);
      }
      const record = get(scope, input.id);
      if (record.status !== 'draft')
        throw new HttpError(
          409,
          'Only an unpublished draft can be revised or cancelled.',
        );
      if (input.action === 'cancel') record.status = 'cancelled';
      else {
        const { action: _action, id: _id, ...content } = input;
        Object.assign(record, content);
      }
      record.version++;
      record.updatedAt = Date.now();
      write(record);
      return JSON.stringify(record);
    }
    if (name !== 'rove_aip_publish' && name !== 'rove_aip_adopt')
      throw new HttpError(404, 'Unknown AIP tool.');
    const record = get(scope, parse(targetInput, args).id);
    const row = saved();
    const repo = String(row?.repo);
    const token = secrets.decrypt(String(row?.token));
    if (record.repo && record.repo !== repo)
      throw new HttpError(
        409,
        'Restore this AIP’s GitHub repository settings before continuing.',
      );
    busy = true;
    active = new AbortController();
    const combined = AbortSignal.any([
      active.signal,
      AbortSignal.timeout(60000),
      ...(signal ? [signal] : []),
    ]);
    async function github(path: string, body?: unknown, method = 'POST') {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}${path}`,
        {
          method: body === undefined ? 'GET' : method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: combined,
          redirect: 'error',
        },
      );
      if (!response.ok)
        throw new HttpError(
          502,
          `GitHub request failed (${response.status}). Check repository access and the AIP’s recorded state.`,
        );
      if (!response.body)
        throw new HttpError(502, 'GitHub returned an empty response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256000)
            throw new HttpError(502, 'The GitHub response was too large.');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new HttpError(502, 'GitHub returned an invalid response.');
      }
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new HttpError(502, 'GitHub returned an invalid response.');
      return result as Record<string, unknown>;
    }
    try {
      if (name === 'rove_aip_publish')
        return JSON.stringify(await publish(record, repo, github));
      return JSON.stringify(await adopt(record, github));
    } finally {
      busy = false;
      active = undefined;
      if (closed) db.close();
    }
  }

  type Github = (
    path: string,
    body?: unknown,
    method?: string,
  ) => Promise<Record<string, unknown>>;
  function requiredString(value: unknown) {
    if (typeof value !== 'string' || !value)
      throw new HttpError(502, 'GitHub returned an incomplete response.');
    return value;
  }
  async function publish(record: Aip, repo: string, github: Github) {
    if (record.status === 'published' || record.status === 'adopted')
      return record;
    if (record.status !== 'draft')
      throw new HttpError(
        409,
        'This AIP cannot be published again. Reconcile any uncertain GitHub outcome manually.',
      );
    const repository = await github('');
    const base = requiredString(repository.default_branch);
    const ref = await github(`/git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = requiredString(
      (ref.object as Record<string, unknown> | undefined)?.sha,
    );
    const commit = await github(`/git/commits/${baseSha}`);
    const baseTree = requiredString(
      (commit.tree as Record<string, unknown> | undefined)?.sha,
    );
    record.repo = repo;
    record.branch = `rove/aip-${record.id}`;
    record.status = 'publishing';
    record.updatedAt = Date.now();
    write(record); // Persist the identity before the first remote mutation; ambiguous failures never auto-replay.
    try {
      const blob = await github('/git/blobs', {
        content: record.skillContent,
        encoding: 'utf-8',
      });
      const tree = await github('/git/trees', {
        base_tree: baseTree,
        tree: [
          {
            path: `.rove/skills/${record.skillName}.md`,
            mode: '100644',
            type: 'blob',
            sha: requiredString(blob.sha),
          },
        ],
      });
      const created = await github('/git/commits', {
        message: `📦 new (aip): add ${record.skillName}`,
        tree: requiredString(tree.sha),
        parents: [baseSha],
      });
      await github('/git/refs', {
        ref: `refs/heads/${record.branch}`,
        sha: requiredString(created.sha),
      });
      const pr = await github('/pulls', {
        title: `AIP ${record.id}: ${record.title}`,
        head: record.branch,
        base,
        draft: true,
        body: `${record.summary}\n\n${record.bullets.map((item) => `- ${item}`).join('\n')}\n\n## Rationale\n\n${record.rationale}\n\n## Validation plan\n\n${record.validation}\n\nThis draft proposes one skill. It does not activate it. Validation above is a plan, not a claim that checks ran.`,
      });
      if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1)
        throw new HttpError(
          502,
          'GitHub returned an invalid pull request number.',
        );
      const url = requiredString(pr.html_url);
      if (url !== `https://github.com/${repo}/pull/${pr.number}`)
        throw new HttpError(
          502,
          'GitHub returned an unexpected pull request URL.',
        );
      record.number = Number(pr.number);
      record.url = url;
      record.status = 'published';
      record.updatedAt = Date.now();
      write(record);
      return record;
    } catch (failure) {
      record.status = 'uncertain';
      record.updatedAt = Date.now();
      write(record);
      throw failure;
    }
  }
  async function adopt(record: Aip, github: Github) {
    if (record.status === 'adopted') return record;
    if (record.status !== 'published' && record.status !== 'adopting')
      throw new HttpError(
        409,
        'Publish and merge this AIP’s pull request before adopting it.',
      );
    if (!onAdopt) throw new HttpError(503, 'Skill adoption is not available.');
    const pr = await github(`/pulls/${record.number}`);
    const base = pr.base as { repo?: { full_name?: string } } | undefined;
    const head = pr.head as { ref?: string } | undefined;
    if (
      pr.merged !== true ||
      base?.repo?.full_name?.toLowerCase() !== record.repo?.toLowerCase() ||
      head?.ref !== record.branch
    ) {
      throw new HttpError(
        409,
        'The matching AIP pull request is not verified as merged.',
      );
    }
    const mergeCommit = requiredString(pr.merge_commit_sha);
    const file = await github(
      `/contents/.rove/skills/${record.skillName}.md?ref=${encodeURIComponent(mergeCommit)}`,
    );
    if (
      file.type !== 'file' ||
      file.encoding !== 'base64' ||
      typeof file.content !== 'string' ||
      Buffer.from(file.content, 'base64').toString('utf8') !==
        record.skillContent
    ) {
      throw new HttpError(
        409,
        'The merged skill differs from the approved proposal. Create a new proposal for the reviewed content.',
      );
    }
    record.status = 'adopting';
    record.mergeCommit = mergeCommit;
    write(record);
    await onAdopt({
      id: record.id,
      name: record.skillName,
      content: record.skillContent,
      enabled: true,
    });
    record.status = 'adopted';
    record.updatedAt = Date.now();
    write(record);
    return record;
  }
  return {
    settings,
    saveSettings,
    preview,
    list,
    tools,
    execute,
    close() {
      if (closed) return;
      closed = true;
      active?.abort();
      if (!busy) db.close();
    },
  };
}
