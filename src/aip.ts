import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  decodedFile,
  githubClient,
  loadRelease,
  shaSchema,
  tagSchema,
  type VerifiedRelease,
  workflowPathSchema,
} from './aip-release.js';
import { HttpError } from './auth.js';
import type { Config } from './config.js';
import { parsePackage, pluginPackage } from './plugin-manifest.js';
import { createSecrets } from './secrets.js';

const proposal = z
  .object({
    packageVersion: pluginPackage.shape.version.default('1.0.0'),
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
    pluginPackage: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Optional complete native Rove API v1 plugin package. Its id and version must match skillName and packageVersion. Core validates the full manifest, source and contributions; skillContent remains the human-readable proposal document.',
      ),
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
const reviewInput = targetInput.extend({ headSha: shaSchema });
const releaseInput = targetInput.extend({ tag: tagSchema });
const settingsInput = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
      .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? '')),
    token: z.string().trim().max(1000).optional(),
    workflowPath: workflowPathSchema.optional(),
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
  | 'adopted'
  | 'reviewed'
  | 'verified'
  | 'activating'
  | 'activated';
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
  baseBranch?: string;
  candidateHead?: string;
  review?: { headSha: string; reviewedAt: number };
  release?: Omit<VerifiedRelease, 'manifest' | 'bytes'>;
}
export interface ReleasedSkill {
  id: string;
  name: string;
  content: string;
  enabled: true;
  release: VerifiedRelease;
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

function packageBytes(record: Proposal) {
  if (record.pluginPackage)
    return `${JSON.stringify(parsePackage(record.pluginPackage))}\n`;
  const generated = {
    schemaVersion: 1,
    apiVersion: 1,
    id: record.skillName,
    name: record.skillName,
    version: record.packageVersion ?? '1.0.0',
    category: 'agent',
    description: record.summary,
    skills: [{ name: record.skillName, markdown: record.skillContent }],
  };
  parsePackage(generated);
  return `${JSON.stringify(generated, null, 2)}\n`;
}

function parseStage(value: unknown) {
  const input = parse(stageInput, value);
  if (input.action !== 'cancel' && input.pluginPackage) {
    if (Buffer.byteLength(JSON.stringify(value)) > 16000)
      throw new HttpError(
        400,
        'Native plugin AIP requests, including proposal fields and source, must fit within 16 KB.',
      );
    const pkg = parsePackage(input.pluginPackage);
    if (pkg.id !== input.skillName || pkg.version !== input.packageVersion)
      throw new HttpError(
        400,
        'The plugin package id and version must match the proposal.',
      );
    input.pluginPackage = pkg;
  } else if (input.action !== 'cancel') packageBytes(input);
  return input;
}

/** Keep source-scoped proposals and require separate final review, release verification and activation. */
export function createAips(
  config: Config,
  onActivate?: (skill: ReleasedSkill) => void | Promise<void>,
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
    if (
      !db
        .prepare('PRAGMA table_info(rove_github)')
        .all()
        .some((column) => column.name === 'workflow_path')
    ) {
      db.exec(
        "ALTER TABLE rove_github ADD COLUMN workflow_path TEXT NOT NULL DEFAULT '.github/workflows/plugin-release.yml'",
      );
    }
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
      workflowPath: row
        ? String(row.workflow_path)
        : '.github/workflows/plugin-release.yml',
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
    db.prepare(`INSERT INTO rove_github(singleton,repo,token,version,workflow_path) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
      repo=excluded.repo, token=excluded.token, version=excluded.version, workflow_path=excluded.workflow_path`).run(
      input.repo,
      input.token ? secrets.encrypt(input.token) : String(existing?.token),
      randomUUID(),
      input.workflowPath ??
        String(
          existing?.workflow_path ?? '.github/workflows/plugin-release.yml',
        ),
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
          'Draft, revise, or cancel an Agent Improvement Proposal in this conversation. Include an exact reusable skill or a complete native pluginPackage, rationale, and a reproducible validation check. A draft never changes active behavior. Revisions replace the complete draft and invalidate earlier approval.',
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
          'Publish this conversation’s stored AIP as a GitHub draft pull request containing its exact proposed package and proposal document. Never merges or adopts it. Inspect the saved proposal first; approval authorizes this exact stored revision and GitHub destination.',
        parameters: z.toJSONSchema(targetInput),
        revision: current,
      },
      ...(
        [
          [
            'inspect',
            'Inspect the final PR revision before human review. Fetches the exact package and proposal document and binds a candidate head SHA. It never approves or activates it.',
            targetInput,
          ],
          [
            'review',
            'Record explicit administrator review of the inspected final PR head SHA and exact proposal content. This is a human decision, distinct from publication, automated checks, merging, or activation.',
            reviewInput,
          ],
          [
            'verify_release',
            'After human review and merge, verify the tagged release artifact against the merge commit, approved package, and configured successful release workflow. Verification does not activate it.',
            releaseInput,
          ],
          [
            'activate',
            'Activate this conversation’s verified release after a separate administrator approval. Rechecks GitHub evidence and installs exactly the pinned artifact. The source repository must be approved in plugin settings.',
            targetInput,
          ],
        ] as const
      ).map(([action, description, schema]) => ({
        name: `rove_aip_${action}`,
        description,
        parameters: z.toJSONSchema(schema),
        revision: current,
      })),
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
      return JSON.stringify({ tool: name, ...parseStage(args) });
    const input = target(name, args);
    return JSON.stringify({
      action: name,
      destination: settings().repo,
      request: input,
      proposal: get(scope, input.id),
    });
  }
  function target(name: string, args: unknown) {
    if (name === 'rove_aip_review') return parse(reviewInput, args);
    if (name === 'rove_aip_verify_release') return parse(releaseInput, args);
    if (
      ['rove_aip_publish', 'rove_aip_inspect', 'rove_aip_activate'].includes(
        name,
      )
    )
      return parse(targetInput, args);
    throw new HttpError(
      404,
      'Unknown AIP tool. Legacy direct adoption is unavailable.',
    );
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
      const input = parseStage(args);
      if (input.action === 'draft') {
        const { action: _action, ...content } = input;
        const existing = list(scope).find(
          (item) =>
            item.status === 'draft' &&
            item.skillName === content.skillName &&
            item.packageVersion === content.packageVersion &&
            item.skillContent === content.skillContent &&
            JSON.stringify(item.pluginPackage) ===
              JSON.stringify(content.pluginPackage),
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
        delete record.pluginPackage;
        Object.assign(record, content);
      }
      record.version++;
      record.updatedAt = Date.now();
      write(record);
      return JSON.stringify(record);
    }
    const input = target(name, args);
    const record = get(scope, input.id);
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
    const client = githubClient(repo, token, combined, fetchImpl);
    const github = client.object;
    try {
      if (name === 'rove_aip_publish')
        return JSON.stringify(await publish(record, repo, github));
      if (record.status === 'adopted' || record.status === 'activated') {
        if (name === 'rove_aip_activate') return JSON.stringify(record);
        throw new HttpError(
          409,
          'This proposal is already active. Create a new proposal to change it.',
        );
      }
      if (
        ![
          'published',
          'adopting',
          'reviewed',
          'verified',
          'activating',
        ].includes(record.status)
      )
        throw new HttpError(
          409,
          'Publish this AIP before reviewing its release.',
        );
      const head = await inspect(record, client);
      if (name === 'rove_aip_inspect') {
        if (record.candidateHead !== head.sha) {
          record.candidateHead = head.sha;
          delete record.review;
          delete record.release;
          record.status = 'published';
        }
      } else if (name === 'rove_aip_review') {
        const requested = parse(reviewInput, input);
        if (
          requested.headSha !== record.candidateHead ||
          requested.headSha !== head.sha
        )
          throw new HttpError(
            409,
            'Inspect the current PR head before reviewing its exact revision.',
          );
        record.review = { headSha: head.sha, reviewedAt: Date.now() };
        delete record.release;
        record.status = 'reviewed';
      } else {
        if (!record.review || record.review.headSha !== head.sha)
          throw new HttpError(
            409,
            'The final PR revision needs fresh human review before release verification or activation.',
          );
        if (!head.mergeCommit)
          throw new HttpError(
            409,
            'The reviewed pull request is not verified as merged.',
          );
        const tag =
          name === 'rove_aip_verify_release'
            ? parse(releaseInput, input).tag
            : record.release?.tag;
        if (!tag)
          throw new HttpError(
            409,
            'Verify a release before requesting separate activation.',
          );
        const release = await loadRelease(
          {
            repo,
            token,
            tag,
            expectedCommit: head.mergeCommit,
            workflowPath: settings().workflowPath,
            signal: combined,
          },
          fetchImpl,
        );
        if (release.bytes !== packageBytes(record))
          throw new HttpError(
            409,
            'The released package differs from the human-reviewed proposal.',
          );
        if (name === 'rove_aip_verify_release') {
          const { manifest: _manifest, bytes: _bytes, ...identity } = release;
          record.release = identity;
          record.mergeCommit = release.commit;
          record.status = 'verified';
        } else {
          if (
            !record.release ||
            !['verified', 'activating'].includes(record.status) ||
            release.digest !== record.release.digest ||
            release.assetId !== record.release.assetId ||
            release.commit !== record.release.commit
          )
            throw new HttpError(
              409,
              'The verified release changed. Verify it again and approve a new activation.',
            );
          if (!onActivate)
            throw new HttpError(503, 'Release activation is not available.');
          record.status = 'activating';
          write(record);
          // The registry must make this idempotent by pinned release identity across crash recovery.
          await onActivate({
            id: record.id,
            name: record.skillName,
            content: record.skillContent,
            enabled: true,
            release,
          });
          record.status = 'activated';
        }
      }
      record.updatedAt = Date.now();
      record.version++;
      write(record);
      return JSON.stringify(record);
    } finally {
      busy = false;
      active = undefined;
      if (closed) db.close();
    }
  }

  type Github = (
    path: string,
    body?: unknown,
  ) => Promise<Record<string, unknown>>;
  function requiredString(value: unknown) {
    if (typeof value !== 'string' || !value)
      throw new HttpError(502, 'GitHub returned an incomplete response.');
    return value;
  }
  async function publish(record: Aip, repo: string, github: Github) {
    if (
      [
        'published',
        'reviewed',
        'verified',
        'activating',
        'activated',
        'adopted',
      ].includes(record.status)
    )
      return record;
    if (record.status !== 'draft')
      throw new HttpError(
        409,
        'This AIP cannot be published again. Reconcile any uncertain GitHub outcome manually.',
      );
    const manifest = packageBytes(record);
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
    record.baseBranch = base;
    record.branch = `rove/aip-${record.id}`;
    record.status = 'publishing';
    record.updatedAt = Date.now();
    write(record); // Persist the identity before the first remote mutation; ambiguous failures never auto-replay.
    try {
      const blob = await github('/git/blobs', {
        content: record.skillContent,
        encoding: 'utf-8',
      });
      const manifestBlob = await github('/git/blobs', {
        content: manifest,
        encoding: 'utf-8',
      });
      const tree = await github('/git/trees', {
        base_tree: baseTree,
        tree: [
          {
            path: 'rove-plugin.json',
            mode: '100644',
            type: 'blob',
            sha: requiredString(manifestBlob.sha),
          },
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
        body: `${record.summary}\n\n${record.bullets.map((item) => `- ${item}`).join('\n')}\n\n## Rationale\n\n${record.rationale}\n\n## Validation plan\n\n${record.validation}\n\nThis draft proposes one versioned plugin package. Human review of its final revision, a successful configured release workflow, a source-matching release artifact, and separate activation are required. It does not activate it. Validation above is a plan, not a claim that checks ran.`,
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
  async function inspect(record: Aip, client: ReturnType<typeof githubClient>) {
    const pr = await client.object(`/pulls/${record.number}`);
    const metadata = z
      .object({
        changed_files: z.number().int().min(1).max(2),
        merged: z.boolean(),
        merge_commit_sha: z.string().nullable(),
        base: z.object({
          ref: z.string(),
          repo: z.object({ full_name: z.string() }),
        }),
        head: z.object({
          ref: z.string(),
          sha: shaSchema,
          repo: z.object({ full_name: z.string() }),
        }),
      })
      .safeParse(pr);
    if (!metadata.success)
      throw new HttpError(
        409,
        'The PR may change only the proposal document and package manifest.',
      );
    const data = metadata.data;
    if (!record.baseBranch) {
      const repo = await client.object('');
      record.baseBranch = requiredString(repo.default_branch);
    }
    if (
      data.base.repo.full_name.toLowerCase() !== record.repo?.toLowerCase() ||
      data.head.repo.full_name.toLowerCase() !== record.repo?.toLowerCase() ||
      data.base.ref !== record.baseBranch ||
      data.head.ref !== record.branch
    )
      throw new HttpError(
        409,
        'The pull request source or destination changed.',
      );
    const paths = [`rove-plugin.json`, `.rove/skills/${record.skillName}.md`];
    const files = z
      .array(
        z.object({
          filename: z.string(),
          status: z.enum(['added', 'modified']),
        }),
      )
      .length(data.changed_files)
      .safeParse(
        await client.request(`/pulls/${record.number}/files?per_page=3`),
      );
    if (
      !files.success ||
      !files.data.every((file) => paths.includes(file.filename)) ||
      new Set(files.data.map((file) => file.filename)).size !==
        files.data.length
    )
      throw new HttpError(
        409,
        'The PR includes changes outside the proposed package.',
      );
    for (const sha of [
      data.head.sha,
      ...(data.merged ? [parse(shaSchema, data.merge_commit_sha)] : []),
    ]) {
      const manifest = decodedFile(
        await client.object(`/contents/rove-plugin.json?ref=${sha}`),
      );
      const skill = decodedFile(
        await client.object(
          `/contents/.rove/skills/${record.skillName}.md?ref=${sha}`,
        ),
      );
      if (manifest !== packageBytes(record) || skill !== record.skillContent)
        throw new HttpError(
          409,
          'The PR content differs from the stored proposal. Create a new proposal for the changed content.',
        );
    }
    return {
      sha: data.head.sha,
      mergeCommit: data.merged ? data.merge_commit_sha : null,
    };
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
