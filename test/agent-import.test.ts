import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { importAgentRelease } from '../src/agent-import.js';

const skill =
  '---\nname: verify-evidence\ndescription: Check sources before making claims.\n---\n\nRead the source and state what it proves.\n';
const metadata = {
  name: 'evidence',
  version: '1.0.0',
  description: 'Verify claims against their sources.',
};
function fixture(files: Record<string, string>) {
  const state = {
    truncated: false,
    mode: '100644',
    corrupt: false,
    blobRequests: 0,
  };
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const blobs = new Map(
    Object.entries(files).map(([path, content]) => {
      const bytes = Buffer.from(content);
      const sha = createHash('sha1')
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest('hex');
      return [sha, { path, content, size: bytes.byteLength, sha }];
    }),
  );
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer dummy-import-token',
    );
    if (url.pathname.endsWith('/releases/tags/v1.0.0'))
      return Response.json({
        id: 12,
        tag_name: 'v1.0.0',
        draft: false,
        prerelease: false,
      });
    if (url.pathname.endsWith('/git/ref/tags/v1.0.0'))
      return Response.json({ object: { type: 'commit', sha: commit } });
    if (url.pathname.endsWith(`/git/commits/${commit}`))
      return Response.json({ tree: { sha: tree } });
    if (url.pathname.endsWith(`/git/trees/${tree}`)) {
      assert.equal(url.searchParams.get('recursive'), '1');
      return Response.json({
        truncated: state.truncated,
        tree: [...blobs.values()].map((file) => ({
          path: file.path,
          sha: file.sha,
          size: file.size,
          type: 'blob',
          mode: state.mode,
        })),
      });
    }
    const sha = url.pathname.split('/').at(-1) ?? '';
    const blob = blobs.get(sha);
    assert.ok(blob, `Unexpected blob ${url}`);
    state.blobRequests++;
    return Response.json({
      sha,
      size: blob.size,
      encoding: 'base64',
      content: Buffer.from(state.corrupt ? 'tampered' : blob.content).toString(
        'base64',
      ),
    });
  };
  return { state, fetchImpl, commit };
}
const request = {
  repo: 'example/evidence',
  tag: 'v1.0.0',
  token: 'dummy-import-token',
};

test('imports released Claude and Cursor skills plus remote MCP without reading environment credentials', async () => {
  for (const format of ['claude-code', 'cursor'] as const) {
    const config =
      format === 'cursor'
        ? {
            variables: {
              type: 'object',
              properties: { API_TOKEN: { type: 'string', title: 'API token' } },
              required: ['API_TOKEN'],
            },
          }
        : {};
    const f = fixture({
      [format === 'cursor'
        ? '.cursor-plugin/plugin.json'
        : '.claude-plugin/plugin.json']: JSON.stringify({
        ...metadata,
        ...config,
      }),
      'skills/verify-evidence/SKILL.md': skill,
      [format === 'cursor' ? 'mcp.json' : '.mcp.json']: JSON.stringify({
        mcpServers: {
          evidence: {
            type: 'http',
            url: 'https://mcp.example.com/mcp',
            headers: { Authorization: `Bearer \${API_TOKEN}` },
          },
        },
      }),
      ...(format === 'cursor'
        ? {
            'rules/evidence.mdc':
              '---\ndescription: Require evidence.\nalwaysApply: true\n---\nCite supporting sources.\n',
          }
        : {}),
    });
    const release = await importAgentRelease(
      { ...request, format },
      f.fetchImpl,
    );
    assert.equal(release.assetId, null);
    assert.equal(release.commit, f.commit);
    assert.equal(release.origin?.format, format);
    assert.equal(release.origin?.releaseId, 12);
    assert.equal(release.manifest.skills[0]?.markdown, skill.trim());
    assert.equal(
      release.manifest.servers[0]?.url,
      'https://mcp.example.com/mcp',
    );
    assert.equal(release.manifest.secrets[0]?.required, true);
    assert.equal(
      release.manifest.servers[0]?.secret,
      release.manifest.secrets[0]?.key,
    );
    assert.doesNotMatch(release.bytes, /dummy-import-token|\$\{API_TOKEN\}/);
    assert.equal(
      release.digest,
      createHash('sha256').update(release.bytes).digest('hex'),
    );
    assert.equal(
      release.origin?.sourceDigest,
      createHash('sha256')
        .update(JSON.stringify(release.origin?.files))
        .digest('hex'),
    );
    assert.equal(
      release.manifest.instructions,
      format === 'cursor' ? 'Cite supporting sources.' : '',
    );
  }
});

test('imports standalone Codex SKILL.md and preserves pinned source digests', async () => {
  const f = fixture({
    'SKILL.md': skill,
    'README.md': 'Example skill documentation.',
  });
  const release = await importAgentRelease(
    { ...request, format: 'codex-skill' },
    f.fetchImpl,
  );
  assert.equal(release.manifest.id, 'verify-evidence');
  assert.equal(release.manifest.version, '1.0.0');
  assert.deepEqual(release.origin?.files, [
    {
      path: 'SKILL.md',
      digest: createHash('sha256').update(skill).digest('hex'),
    },
  ]);
  assert.equal(f.state.blobRequests, 1);
  const unchanged = await importAgentRelease(
    { ...request, format: 'codex-skill' },
    f.fetchImpl,
  );
  assert.equal(unchanged.digest, release.digest);
});

test('rejects unsafe trees, corrupted source, traversal and incomplete source enumeration', async () => {
  for (const mode of ['120000', '160000', '100755']) {
    const f = fixture({ 'SKILL.md': skill });
    f.state.mode = mode;
    await assert.rejects(
      importAgentRelease({ ...request, format: 'codex-skill' }, f.fetchImpl),
      /regular files/,
    );
    assert.equal(f.state.blobRequests, 0);
  }
  const truncated = fixture({ 'SKILL.md': skill });
  truncated.state.truncated = true;
  await assert.rejects(
    importAgentRelease(
      { ...request, format: 'codex-skill' },
      truncated.fetchImpl,
    ),
    /regular files/,
  );
  const corrupt = fixture({ 'SKILL.md': skill });
  corrupt.state.corrupt = true;
  await assert.rejects(
    importAgentRelease(
      { ...request, format: 'codex-skill' },
      corrupt.fetchImpl,
    ),
    /integrity/,
  );
  const traversal = fixture({
    '.claude-plugin/plugin.json': JSON.stringify({
      ...metadata,
      skills: '../secrets',
    }),
  });
  await assert.rejects(
    importAgentRelease(
      { ...request, format: 'claude-code' },
      traversal.fetchImpl,
    ),
    /within/,
  );
  const oversized = fixture({ 'SKILL.md': `${skill}${'x'.repeat(32000)}` });
  await assert.rejects(
    importAgentRelease(
      { ...request, format: 'codex-skill' },
      oversized.fetchImpl,
    ),
    /per-file/,
  );
});

test('rejects unsupported executable behavior and authority without silently importing a partial plugin', async () => {
  for (const extra of [
    { hooks: { SessionStart: [] } },
    { mcpServers: { local: { command: 'node', args: ['server.js'] } } },
    {
      mcpServers: {
        remote: { type: 'sse', url: 'https://mcp.example.com/sse' },
      },
    },
    {
      mcpServers: {
        remote: {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: 'Bearer literal-secret' },
        },
      },
    },
  ]) {
    const f = fixture({
      '.claude-plugin/plugin.json': JSON.stringify({ ...metadata, ...extra }),
      'skills/verify-evidence/SKILL.md': skill,
    });
    await assert.rejects(
      importAgentRelease({ ...request, format: 'claude-code' }, f.fetchImpl),
      /Unsupported Agent Plugin/,
    );
  }
  const resources: Array<Record<string, string>> = [
    { 'scripts/run.sh': 'echo hi' },
    { 'references/source.md': 'Needed reference' },
    { 'agents/openai.yaml': 'policy:\n  allow_implicit_invocation: false\n' },
  ];
  for (const extra of resources) {
    const f = fixture({ 'SKILL.md': skill, ...extra });
    await assert.rejects(
      importAgentRelease({ ...request, format: 'codex-skill' }, f.fetchImpl),
      /Unsupported Agent Plugin/,
    );
  }
  const permissions = fixture({
    'SKILL.md': skill.replace(
      'description:',
      'allowed-tools: Bash\ndescription:',
    ),
  });
  await assert.rejects(
    importAgentRelease(
      { ...request, format: 'codex-skill' },
      permissions.fetchImpl,
    ),
    /frontmatter/,
  );
  const conditional = fixture({
    '.cursor-plugin/plugin.json': JSON.stringify(metadata),
    'rules/scoped.mdc':
      '---\ndescription: Conditional\nalwaysApply: false\n---\nOnly on demand.\n',
  });
  await assert.rejects(
    importAgentRelease({ ...request, format: 'cursor' }, conditional.fetchImpl),
    /conditional/,
  );
  const undeclared = fixture({
    '.cursor-plugin/plugin.json': JSON.stringify({
      ...metadata,
      mcpServers: {
        remote: {
          url: 'https://mcp.example.com/mcp',
          headers: { Authorization: `Bearer \${MISSING}` },
        },
      },
    }),
  });
  await assert.rejects(
    importAgentRelease({ ...request, format: 'cursor' }, undeclared.fetchImpl),
    /declared/,
  );
});

test('custom skill locations work without defaults and preserve publisher notices', async () => {
  const f = fixture({
    '.claude-plugin/plugin.json': JSON.stringify({
      ...metadata,
      skills: './custom/verify',
      license: 'MIT',
      author: { name: 'Example Publisher' },
    }),
    'custom/verify/SKILL.md': skill,
    LICENSE: 'Example license notice for an internal test fixture.',
  });
  const release = await importAgentRelease(
    { ...request, format: 'claude-code' },
    f.fetchImpl,
  );
  assert.equal(release.manifest.skills.length, 1);
  assert.equal(release.origin?.metadata?.license, 'MIT');
  assert.equal(release.origin?.metadata?.author?.name, 'Example Publisher');
  assert.equal(release.origin?.metadata?.notices?.[0]?.path, 'LICENSE');
  assert.equal(
    release.origin?.metadata?.notices?.[0]?.text,
    'Example license notice for an internal test fixture.',
  );
});
