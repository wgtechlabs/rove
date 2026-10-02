import { createHash } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from './auth.js';
import { type PluginPackage, parsePackage } from './plugin-manifest.js';

const MAX_BYTES = 256000;
export const workflowPathSchema = z
  .string()
  .regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/);
export const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const tagSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes('..'));
const repoSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value.split('/')[1] ?? ''));
export interface VerifiedRelease {
  repo: string;
  tag: string;
  commit: string;
  digest: string;
  assetId: number | null;
  origin?: {
    format: 'claude-code' | 'cursor' | 'codex-skill';
    releaseId: number;
    sourceDigest: string;
    files: Array<{ path: string; digest: string }>;
    metadata?: {
      license?: string;
      author?: { name: string; email?: string; url?: string };
      homepage?: string;
      repository?: string;
      notices?: Array<{ path: string; text: string }>;
    };
  };
  manifest: PluginPackage;
  bytes: string;
  workflowRunId?: number;
}
export interface ReleaseRequest {
  repo: string;
  tag: string;
  token?: string;
  workflowPath?: string;
  expectedCommit?: string;
  signal?: AbortSignal;
}

export async function boundedText(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(
      502,
      `GitHub request failed (${response.status}). Check repository access and recorded state.`,
    );
  }
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
      if (size > MAX_BYTES)
        throw new HttpError(502, 'The GitHub response was too large.');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function githubClient(
  repo: string,
  token: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  repoSchema.parse(repo);
  if (/[\r\n]/.test(token ?? ''))
    throw new HttpError(400, 'Invalid GitHub token.');
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  async function request(path: string, body?: unknown) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}${path}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: 'error',
      },
    );
    try {
      return JSON.parse(await boundedText(response)) as unknown;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'GitHub returned an invalid response.');
    }
  }
  return {
    request,
    async object(
      path: string,
      body?: unknown,
    ): Promise<Record<string, unknown>> {
      const result = await request(path, body);
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new HttpError(502, 'GitHub returned an invalid response.');
      return result as Record<string, unknown>;
    },
    async asset(id: number) {
      let response = await fetchImpl(
        `https://api.github.com/repos/${repo}/releases/assets/${id}`,
        {
          headers: { ...headers, Accept: 'application/octet-stream' },
          signal,
          redirect: 'manual',
        },
      );
      if (response.status === 302) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        let url: URL;
        try {
          url = new URL(location ?? '');
        } catch {
          throw new HttpError(
            502,
            'GitHub returned an invalid asset redirect.',
          );
        }
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.port ||
          ![
            'release-assets.githubusercontent.com',
            'objects.githubusercontent.com',
          ].includes(url.hostname)
        )
          throw new HttpError(
            502,
            'GitHub returned an untrusted asset redirect.',
          );
        // Signed asset URLs need no GitHub credential; never forward it to the CDN.
        response = await fetchImpl(url, { signal, redirect: 'error' });
      }
      return boundedText(response);
    },
  };
}

export function decodedFile(value: unknown): string {
  const file = z
    .object({
      type: z.literal('file'),
      encoding: z.literal('base64'),
      content: z.string().max(MAX_BYTES),
    })
    .safeParse(value);
  if (!file.success)
    throw new HttpError(409, 'The committed package file is unavailable.');
  try {
    const encoded = file.data.content.replace(/\r?\n/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_BYTES || bytes.toString('base64') !== encoded)
      throw new Error('Invalid base64.');
    // Preserve a BOM and reject invalid UTF-8 instead of normalizing source bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new HttpError(
      409,
      'The committed package file is invalid base64 or UTF-8.',
    );
  }
}

/** Compare downloaded bytes with committed source, and optionally require trusted Actions provenance. */
export async function loadRelease(
  input: ReleaseRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedRelease> {
  repoSchema.parse(input.repo);
  tagSchema.parse(input.tag);
  if (input.expectedCommit) shaSchema.parse(input.expectedCommit);
  if (input.workflowPath) workflowPathSchema.parse(input.workflowPath);
  const signal = AbortSignal.any([
    AbortSignal.timeout(60000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const github = githubClient(input.repo, input.token, signal, fetchImpl);
  const release = z
    .object({
      tag_name: z.string(),
      draft: z.literal(false),
      prerelease: z.literal(false),
      assets: z
        .array(
          z.object({
            id: z.number().int().positive(),
            name: z.string(),
            state: z.string(),
            size: z.number().int().nonnegative(),
            digest: z.string().nullable().optional(),
          }),
        )
        .max(100),
    })
    .parse(
      await github.object(`/releases/tags/${encodeURIComponent(input.tag)}`),
    );
  if (release.tag_name !== input.tag)
    throw new HttpError(409, 'The release tag does not match.');
  let ref = z
    .object({
      object: z.object({ type: z.enum(['tag', 'commit']), sha: shaSchema }),
    })
    .parse(
      await github.object(`/git/ref/tags/${encodeURIComponent(input.tag)}`),
    ).object;
  for (let depth = 0; ref.type === 'tag' && depth < 5; depth++) {
    ref = z
      .object({
        object: z.object({ type: z.enum(['tag', 'commit']), sha: shaSchema }),
      })
      .parse(await github.object(`/git/tags/${ref.sha}`)).object;
  }
  if (
    ref.type !== 'commit' ||
    (input.expectedCommit && ref.sha !== input.expectedCommit)
  )
    throw new HttpError(
      409,
      'The release does not point to the expected commit.',
    );
  const commit = ref.sha;
  let workflowRunId: number | undefined;
  if (input.workflowPath) {
    const workflow = z
      .object({
        id: z.number().int().positive(),
        path: z.string(),
        state: z.literal('active'),
      })
      .parse(
        await github.object(
          `/actions/workflows/${encodeURIComponent(input.workflowPath.split('/').at(-1) ?? '')}`,
        ),
      );
    if (workflow.path !== input.workflowPath)
      throw new HttpError(409, 'The required release workflow does not match.');
    const runs = z
      .object({
        workflow_runs: z
          .array(
            z.object({
              id: z.number().int().positive(),
              workflow_id: z.number().int(),
              head_sha: shaSchema,
              status: z.string(),
              conclusion: z.string().nullable(),
              event: z.string(),
              repository: z.object({ full_name: z.string() }),
              head_repository: z.object({ full_name: z.string() }),
            }),
          )
          .max(1),
      })
      .parse(
        await github.object(
          `/actions/workflows/${workflow.id}/runs?head_sha=${commit}&per_page=1`,
        ),
      );
    const run = runs.workflow_runs[0];
    if (
      !run ||
      run.workflow_id !== workflow.id ||
      run.head_sha !== commit ||
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      !['push', 'release', 'workflow_dispatch'].includes(run.event) ||
      run.repository.full_name.toLowerCase() !== input.repo.toLowerCase() ||
      run.head_repository.full_name.toLowerCase() !== input.repo.toLowerCase()
    )
      throw new HttpError(
        409,
        'The required release workflow has no verified successful run for this commit.',
      );
    workflowRunId = run.id;
  }
  const assets = release.assets.filter(
    (asset) => asset.name === 'rove-plugin.json',
  );
  const asset = assets[0];
  if (
    assets.length !== 1 ||
    !asset ||
    asset.state !== 'uploaded' ||
    asset.size > MAX_BYTES
  )
    throw new HttpError(
      409,
      'The release must contain one bounded rove-plugin.json asset.',
    );
  const source = decodedFile(
    await github.object(`/contents/rove-plugin.json?ref=${commit}`),
  );
  const bytes = await github.asset(asset.id);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    bytes !== source ||
    Buffer.byteLength(bytes) !== asset.size ||
    (asset.digest && asset.digest !== `sha256:${digest}`)
  )
    throw new HttpError(
      409,
      'The released artifact differs from its committed source or digest.',
    );
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new HttpError(409, 'The released package is invalid JSON.');
  }
  const manifest = parsePackage(value);
  return {
    repo: input.repo,
    tag: input.tag,
    commit,
    digest,
    assetId: asset.id,
    manifest,
    bytes,
    ...(workflowRunId ? { workflowRunId } : {}),
  };
}
