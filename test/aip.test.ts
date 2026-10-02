import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { type TestContext, test } from 'node:test';
import { createAips, type ReleasedSkill } from '../src/aip.js';
import { createChat } from '../src/chat.js';
import { createExtensions } from '../src/extensions.js';
import { parsePackage } from '../src/plugin-manifest.js';
import { createPlugins } from '../src/plugins.js';
import type { RuntimeConfig } from '../src/runtime.js';
import { testRuntime } from './storage.js';

const githubSettings = {
  repo: 'example/knowledge',
  token: 'dummy-github-token',
};
const draft = {
  action: 'draft',
  packageVersion: '1.0.0',
  title: 'Verify before answering',
  summary: 'Use cited evidence.',
  bullets: ['Read the relevant source before making a claim.'],
  skillName: 'verify-evidence',
  skillContent:
    '# Verify evidence\n\nRead the source and cite what it proves.\n',
  rationale: 'Unsupported claims can mislead the company.',
  validation:
    'Ask for an unavailable fact; the agent must say it cannot verify it.',
};
const nativePackage = {
  schemaVersion: 1,
  apiVersion: 1,
  id: draft.skillName,
  name: draft.skillName,
  version: draft.packageVersion,
  category: 'user',
  description: draft.summary,
  capabilities: ['execute:offline'],
  execution: {
    runtime: 'node',
    source: 'export function run(input) { return input.args; }',
  },
  operations: [
    {
      id: 'echo',
      name: 'Echo',
      description: 'Return the approved input.',
      inputSchema: { type: 'object' },
      surfaces: ['tool', 'action', 'step'],
    },
  ],
};
const oversizedDraft = {
  ...draft,
  pluginPackage: {
    ...nativePackage,
    execution: { runtime: 'node', source: 'x'.repeat(16000) },
  },
};
async function fixture(t: TestContext) {
  const config: RuntimeConfig = {
    ...(await testRuntime(t)),
    baseURL: 'http://localhost:3000',
    authSecret: 'test-auth-secret-'.repeat(4),
  };
  const calls: Array<{
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  const state = {
    merged: false,
    skill: draft.skillContent,
    manifest: '',
    head: 'a'.repeat(40),
    merge: 'b'.repeat(40),
    workflow: 'success',
    workflowRepo: 'example/knowledge',
    workflowPath: '.github/workflows/plugin-release.yml',
    files: [
      { filename: 'rove-plugin.json', status: 'added' },
      { filename: `.rove/skills/${draft.skillName}.md`, status: 'added' },
    ],
    assetId: 9,
    releaseExtra: '',
    tagCommit: 'b'.repeat(40),
  };
  let failAt = '';
  let branch = '';
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({ path, method, body });
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer dummy-github-token',
    );
    assert.equal(
      init?.redirect,
      path.includes('/releases/assets/') ? 'manual' : 'error',
    );
    if (path === failAt) throw new TypeError('Connection lost after request');
    let result: unknown;
    if (path.endsWith('/pulls/42'))
      result = {
        merged: state.merged,
        changed_files: state.files.length,
        merge_commit_sha: state.merged ? state.merge : null,
        base: { ref: 'main', repo: { full_name: 'example/knowledge' } },
        head: {
          ref: branch,
          sha: state.head,
          repo: { full_name: 'example/knowledge' },
        },
      };
    else if (path.endsWith('/pulls/42/files')) result = state.files;
    else if (path.includes('/contents/')) {
      assert.ok(
        [state.head, state.merge].includes(
          new URL(String(input)).searchParams.get('ref') ?? '',
        ),
      );
      result = {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(
          path.endsWith('rove-plugin.json') ? state.manifest : state.skill,
        ).toString('base64'),
      };
    } else if (path.endsWith('/releases/tags/v1.0.0'))
      result = {
        tag_name: 'v1.0.0',
        draft: false,
        prerelease: false,
        assets: [
          {
            id: state.assetId,
            name: 'rove-plugin.json',
            state: 'uploaded',
            size: Buffer.byteLength(state.manifest + state.releaseExtra),
          },
        ],
      };
    else if (path.includes('/releases/assets/'))
      return new Response(state.manifest + state.releaseExtra);
    else if (path.endsWith('/git/ref/tags/v1.0.0'))
      result = { object: { type: 'commit', sha: state.tagCommit } };
    else if (path.endsWith('/actions/workflows/plugin-release.yml'))
      result = { id: 7, path: state.workflowPath, state: 'active' };
    else if (path.endsWith('/actions/workflows/7/runs'))
      result = {
        workflow_runs: [
          {
            id: 8,
            workflow_id: 7,
            head_sha: state.merge,
            status: 'completed',
            conclusion: state.workflow,
            event: 'push',
            repository: { full_name: state.workflowRepo },
            head_repository: { full_name: state.workflowRepo },
          },
        ],
      };
    else if (path.endsWith('/git/ref/heads/main'))
      result = { object: { sha: 'base-sha' } };
    else if (path.endsWith('/git/commits/base-sha'))
      result = { tree: { sha: 'base-tree' } };
    else if (path.endsWith('/git/blobs')) {
      if (String(body?.content).startsWith('{'))
        state.manifest = String(body?.content);
      result = {
        sha: String(body?.content).startsWith('{')
          ? 'manifest-blob'
          : 'skill-blob',
      };
    } else if (path.endsWith('/git/trees')) result = { sha: 'skill-tree' };
    else if (path.endsWith('/git/commits')) result = { sha: 'skill-commit' };
    else if (path.endsWith('/git/refs')) {
      branch = String(body?.ref).replace('refs/heads/', '');
      result = { ref: body?.ref };
    } else if (path.endsWith('/pulls'))
      result = {
        number: 42,
        html_url: 'https://github.com/example/knowledge/pull/42',
      };
    else if (path === '/repos/example/knowledge')
      result = { default_branch: 'main' };
    else assert.fail(`Unexpected GitHub request: ${path}`);
    return Response.json(result);
  };
  return {
    config,
    calls,
    fetchImpl,
    state,
    merge(content = draft.skillContent) {
      state.merged = true;
      state.skill = content;
    },
    fail(path: string) {
      failAt = path;
    },
  };
}
async function revision(
  service: Awaited<ReturnType<typeof createAips>>,
  scope = 'web:one',
) {
  const tool = (await service.tools(scope))[0];
  assert.ok(tool);
  return tool.revision;
}

test('AIP drafts persist, preserve scope, invalidate approvals, and cancel without external calls', async (t) => {
  const f = await fixture(t);
  let service = await createAips(f.config, undefined, f.fetchImpl);
  try {
    assert.deepEqual(await service.tools('web:one'), []);
    await assert.rejects(
      async () =>
        await service.saveSettings({
          repo: 'example/..',
          token: 'dummy-github-token',
        }),
    );
    await service.saveSettings(githubSettings);
    assert.deepEqual(await service.settings(), {
      repo: 'example/knowledge',
      configured: true,
      workflowPath: '.github/workflows/plugin-release.yml',
    });
    assert.deepEqual(
      JSON.parse(await service.preview('rove_aip_stage', draft, 'web:one')),
      { tool: 'rove_aip_stage', ...draft },
    );
    const initial = await revision(service);
    const created = JSON.parse(
      await service.execute('rove_aip_stage', draft, initial, 'web:one'),
    );
    assert.equal(created.status, 'draft');
    const preview = JSON.parse(
      await service.preview('rove_aip_publish', { id: created.id }, 'web:one'),
    );
    assert.equal(preview.destination, 'example/knowledge');
    assert.equal(preview.proposal.skillContent, draft.skillContent);
    await assert.rejects(
      async () =>
        await service.preview(
          'rove_aip_activate',
          { id: created.id },
          'web:other',
        ),
      /not found/,
    );
    assert.deepEqual(await service.list('slack:other'), []);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        await revision(service, 'slack:other'),
        'slack:other',
      ),
      /not found/,
    );
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        initial,
        'web:one',
      ),
      /changed/,
    );
    const beforeRevision = await revision(service);
    await service.execute(
      'rove_aip_stage',
      {
        ...draft,
        action: 'revise',
        id: created.id,
        summary: 'Check sources and state any gaps.',
      },
      beforeRevision,
      'web:one',
    );
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        beforeRevision,
        'web:one',
      ),
      /changed/,
    );
    assert.equal(
      (await service.list('web:one'))[0]?.summary,
      'Check sources and state any gaps.',
    );
    const beforeConfig = await revision(service);
    await service.saveSettings({ repo: 'example/knowledge', token: '' });
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        beforeConfig,
        'web:one',
      ),
      /changed/,
    );
    await service.execute(
      'rove_aip_stage',
      { action: 'cancel', id: created.id },
      await revision(service),
      'web:one',
    );
    service.close();
    assert.ok(
      !JSON.stringify(
        await f.config.db.all('SELECT * FROM rove_github'),
      ).includes('dummy-github-token'),
    );
    service = await createAips(f.config, undefined, f.fetchImpl);
    assert.equal((await service.list('web:one'))[0]?.status, 'cancelled');
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        await revision(service),
        'web:one',
      ),
      /cannot be published/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    service.close();
  }
});

test('native executable AIPs with unchanged proposal documents require final review, a verified release and separate activation across restart', async (t) => {
  const f = await fixture(t);
  const activated: ReleasedSkill[] = [];
  const activate = (skill: ReleasedSkill) => {
    activated.push(skill);
  };
  let service = await createAips(f.config, activate, f.fetchImpl);
  const run = async (name: string, args: unknown) =>
    service.execute(
      `rove_aip_${name}`,
      args,
      await revision(service),
      'web:one',
    );
  try {
    await service.saveSettings(githubSettings);
    const nativeDraft = { ...draft, pluginPackage: nativePackage };
    await assert.rejects(run('stage', oversizedDraft), /16 KB/);
    assert.equal((await service.list('web:one')).length, 0);
    const created = JSON.parse(await run('stage', nativeDraft));
    await assert.rejects(
      run('stage', { ...oversizedDraft, action: 'revise', id: created.id }),
      /16 KB/,
    );
    assert.equal((await service.list('web:one'))[0]?.version, 1);
    assert.equal(JSON.parse(await run('stage', nativeDraft)).id, created.id);
    const changed = JSON.parse(
      await run('stage', {
        ...nativeDraft,
        pluginPackage: { ...nativePackage, description: 'Changed package' },
      }),
    );
    assert.notEqual(changed.id, created.id);
    await run('stage', { ...draft, action: 'revise', id: changed.id });
    assert.equal(
      (await service.list('web:one')).find((item) => item.id === changed.id)
        ?.pluginPackage,
      undefined,
    );
    const target = { id: created.id };
    const published = JSON.parse(await run('publish', target));
    assert.equal(
      f.state.manifest,
      `${JSON.stringify(parsePackage(nativePackage))}\n`,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(nativeDraft)) < 16000);
    assert.equal(published.status, 'published');
    // GitHub omits the unchanged proposal document from a package-only update.
    f.state.files = [{ filename: 'rove-plugin.json', status: 'modified' }];
    const pr = f.calls.find((call) => call.path.endsWith('/pulls'));
    assert.equal(pr?.body?.draft, true);
    assert.equal(pr?.body?.base, 'main');
    assert.equal(pr?.body?.head, `rove/aip-${created.id}`);
    assert.doesNotMatch(String(pr?.body?.body), /web:one/);
    const tree = f.calls.find((call) => call.path.endsWith('/git/trees'))?.body
      ?.tree;
    assert.ok(Array.isArray(tree));
    assert.deepEqual(
      tree.map((file) => file.path),
      ['rove-plugin.json', '.rove/skills/verify-evidence.md'],
    );
    assert.equal(
      (await service.tools('web:one')).some(
        (tool) => tool.name === 'rove_aip_adopt',
      ),
      false,
    );
    await assert.rejects(run('adopt', target), /Legacy direct adoption/);
    f.merge();
    await assert.rejects(run('activate', target), /fresh human review/);
    await assert.rejects(
      run('review', { ...target, headSha: f.state.head }),
      /Inspect/,
    );
    const inspected = JSON.parse(await run('inspect', target));
    assert.equal(inspected.candidateHead, f.state.head);
    const reviewPreview = JSON.parse(
      await service.preview(
        'rove_aip_review',
        { ...target, headSha: f.state.head },
        'web:one',
      ),
    );
    assert.equal(reviewPreview.proposal.skillContent, draft.skillContent);
    assert.equal(reviewPreview.request.headSha, f.state.head);
    await run('review', { ...target, headSha: f.state.head });
    const reviewedBytes = f.state.manifest;
    f.state.manifest = reviewedBytes.replace(
      nativePackage.execution.source,
      'export function run() { return 2; }',
    );
    f.state.head = 'd'.repeat(40);
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /differs/,
    );
    f.state.manifest = reviewedBytes;
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /fresh human review/,
    );
    await run('inspect', target);
    await run('review', { ...target, headSha: f.state.head });
    await assert.rejects(run('activate', target), /Verify a release/);
    f.state.workflow = 'failure';
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /workflow/,
    );
    f.state.workflow = 'success';
    f.state.workflowRepo = 'attacker/fork';
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /workflow/,
    );
    f.state.workflowRepo = 'example/knowledge';
    f.state.tagCommit = 'c'.repeat(40);
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /expected commit/,
    );
    f.state.tagCommit = f.state.merge;
    f.state.releaseExtra = ' ';
    await assert.rejects(
      run('verify_release', { ...target, tag: 'v1.0.0' }),
      /differs/,
    );
    f.state.releaseExtra = '';
    const verified = JSON.parse(
      await run('verify_release', { ...target, tag: 'v1.0.0' }),
    );
    assert.equal(verified.status, 'verified');
    assert.equal(activated.length, 0);
    service.close();
    service = await createAips(f.config, activate, f.fetchImpl);
    f.state.assetId++;
    await assert.rejects(run('activate', target), /verified release changed/);
    f.state.assetId--;
    f.state.head = 'c'.repeat(40);
    await assert.rejects(run('activate', target), /fresh human review/);
    await run('inspect', target);
    assert.equal((await service.list('web:one'))[0]?.release, undefined);
    await run('review', { ...target, headSha: f.state.head });
    await run('verify_release', { ...target, tag: 'v1.0.0' });
    const active = JSON.parse(await run('activate', target));
    assert.equal(active.status, 'activated');
    assert.equal(activated.length, 1);
    assert.equal(activated[0]?.id, created.id);
    assert.equal(activated[0]?.release.commit, f.state.merge);
    assert.equal(activated[0]?.release.bytes, f.state.manifest);
    const count = f.calls.length;
    service.close();
    service = await createAips(
      f.config,
      () => assert.fail('Activation must not replay'),
      f.fetchImpl,
    );
    await run('activate', target);
    await run('publish', target);
    assert.equal(f.calls.length, count);
  } finally {
    service.close();
  }
});

test('legacy pending adoption remains blocked and adopted data stays intact through additive migration', async (t) => {
  const f = await fixture(t);
  let service = await createAips(f.config, undefined, f.fetchImpl);
  try {
    await service.saveSettings(githubSettings);
    const draftRecord = JSON.parse(
      await service.execute(
        'rove_aip_stage',
        draft,
        await revision(service),
        'web:one',
      ),
    );
    const target = { id: draftRecord.id };
    await service.execute(
      'rove_aip_publish',
      target,
      await revision(service),
      'web:one',
    );
    f.merge();
    const published = (await service.list('web:one'))[0];
    service.close();
    const db = f.config.db;
    const pending = { ...published, status: 'adopting' };
    await db.run('UPDATE rove_aip SET data=$1 WHERE id=$2', [
      JSON.stringify(pending),
      draftRecord.id,
    ]);
    for (let restart = 0; restart < 2; restart++) {
      service = await createAips(
        f.config,
        () => assert.fail('Legacy adoption must not replay'),
        f.fetchImpl,
      );
      assert.equal((await service.list('web:one'))[0]?.id, draftRecord.id);
      assert.equal((await service.list('web:one'))[0]?.status, 'adopting');
      await assert.rejects(
        service.execute(
          'rove_aip_adopt',
          target,
          await revision(service),
          'web:one',
        ),
        /Legacy direct adoption/,
      );
      await assert.rejects(
        service.execute(
          'rove_aip_activate',
          target,
          await revision(service),
          'web:one',
        ),
        /fresh human review/,
      );
      service.close();
    }
    const old = f.config.db;
    await old.run('UPDATE rove_aip SET data=$1 WHERE id=$2', [
      JSON.stringify({ ...pending, status: 'adopted' }),
      draftRecord.id,
    ]);
    service = await createAips(
      f.config,
      () => assert.fail('Old adopted data must stay as-is'),
      f.fetchImpl,
    );
    const count = f.calls.length;
    await service.execute(
      'rove_aip_activate',
      target,
      await revision(service),
      'web:one',
    );
    assert.equal(f.calls.length, count);
    assert.equal((await service.list('web:one'))[0]?.status, 'adopted');
    assert.equal((await service.list('web:one'))[0]?.release, undefined);
  } finally {
    service.close();
  }
});

test('PR files and final content cannot change outside the reviewed package', async (t) => {
  const f = await fixture(t);
  const service = await createAips(f.config, undefined, f.fetchImpl);
  const run = async (name: string, args: unknown) =>
    service.execute(
      `rove_aip_${name}`,
      args,
      await revision(service),
      'web:one',
    );
  try {
    await service.saveSettings(githubSettings);
    const created = JSON.parse(await run('stage', draft));
    const target = { id: created.id };
    await run('publish', target);
    for (const files of [
      [{ filename: '.github/workflows/plugin-release.yml', status: 'added' }],
      [{ filename: 'rove-plugin.json', status: 'removed' }],
      [{ filename: 'rove-plugin.json', status: 'renamed' }],
      [
        { filename: 'rove-plugin.json', status: 'added' },
        { filename: 'rove-plugin.json', status: 'modified' },
      ],
    ]) {
      f.state.files = files;
      await assert.rejects(run('inspect', target), /outside/);
    }
    f.state.files = [{ filename: 'rove-plugin.json', status: 'modified' }];
    f.state.skill = '# Unauthorized replacement';
    await assert.rejects(run('inspect', target), /differs/);
    assert.equal((await service.list('web:one'))[0]?.review, undefined);
  } finally {
    service.close();
  }
});

test('generated AIP packages validate before saving drafts or revisions', async (t) => {
  const f = await fixture(t);
  const service = await createAips(f.config, undefined, f.fetchImpl);
  const run = async (args: unknown) =>
    service.execute('rove_aip_stage', args, await revision(service), 'web:one');
  try {
    await service.saveSettings(githubSettings);
    const boundaryVersion = `${'1'.repeat(36)}.0.0`;
    const tooLong = { ...draft, packageVersion: `${'1'.repeat(37)}.0.0` };
    await assert.rejects(
      async () => await service.preview('rove_aip_stage', tooLong, 'web:one'),
      /Invalid AIP fields/,
    );
    await assert.rejects(run(tooLong), /Invalid AIP fields/);
    assert.equal((await service.list('web:one')).length, 0);
    const created = JSON.parse(
      await run({ ...draft, packageVersion: boundaryVersion }),
    );
    await assert.rejects(
      run({ ...tooLong, action: 'revise', id: created.id }),
      /Invalid AIP fields/,
    );
    for (const action of ['draft', 'revise'])
      await assert.rejects(
        run({
          ...draft,
          action,
          ...(action === 'revise' ? { id: created.id } : {}),
          skillContent: `Use \${settings.undeclared}.`,
        }),
        /Unsupported plugin manifest/,
      );
    assert.equal((await service.list('web:one')).length, 1);
    assert.equal(
      (await service.list('web:one'))[0]?.packageVersion,
      boundaryVersion,
    );
    assert.equal((await service.list('web:one'))[0]?.version, 1);
    const db = f.config.db;
    await db.run('UPDATE rove_aip SET data=$1 WHERE id=$2', [
      JSON.stringify({ ...created, packageVersion: tooLong.packageVersion }),
      created.id,
    ]);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        await revision(service),
        'web:one',
      ),
      /Unsupported plugin manifest/,
    );
    assert.equal((await service.list('web:one'))[0]?.status, 'draft');
    assert.equal(f.calls.length, 0);
  } finally {
    service.close();
  }
});

test('an unknown GitHub outcome remains blocked after restart and cannot duplicate a PR', async (t) => {
  const f = await fixture(t);
  let service = await createAips(f.config, undefined, f.fetchImpl);
  try {
    await service.saveSettings(githubSettings);
    const created = JSON.parse(
      await service.execute(
        'rove_aip_stage',
        draft,
        await revision(service),
        'web:one',
      ),
    );
    f.fail('/repos/example/knowledge/pulls');
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        await revision(service),
        'web:one',
      ),
      /Connection lost/,
    );
    assert.equal((await service.list('web:one'))[0]?.status, 'uncertain');
    assert.equal(
      (await service.list('web:one'))[0]?.branch,
      `rove/aip-${created.id}`,
    );
    const count = f.calls.length;
    service.close();
    service = await createAips(f.config, undefined, f.fetchImpl);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        await revision(service),
        'web:one',
      ),
      /uncertain/,
    );
    assert.equal(f.calls.length, count);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      service.execute(
        'rove_aip_stage',
        draft,
        await revision(service),
        'web:one',
        controller.signal,
      ),
      /cancelled/,
    );
  } finally {
    service.close();
  }
});

test('AIP skill, scope storage, and GitHub response bounds fail before writes', async (t) => {
  const f = await fixture(t);
  let requested = 0;
  const service = await createAips(f.config, undefined, async () => {
    requested++;
    return new Response('x'.repeat(256001));
  });
  try {
    await service.saveSettings(githubSettings);
    await assert.rejects(
      service.execute(
        'rove_aip_stage',
        { ...draft, skillContent: 'x'.repeat(8001) },
        await revision(service),
        'web:one',
      ),
    );
    assert.equal((await service.list('web:one')).length, 0);
    for (const pluginPackage of [
      { ...nativePackage, id: 'wrong' },
      { ...nativePackage, version: '2.0.0' },
      { ...nativePackage, execution: { runtime: 'host', source: 'unsafe' } },
    ])
      await assert.rejects(
        service.execute(
          'rove_aip_stage',
          { ...draft, pluginPackage },
          await revision(service),
          'web:one',
        ),
      );
    for (let index = 0; index < 100; index++) {
      await service.execute(
        'rove_aip_stage',
        { ...draft, skillName: `evidence-${index}` },
        await revision(service),
        'web:one',
      );
    }
    assert.equal((await service.list('web:one')).length, 100);
    await assert.rejects(
      service.execute(
        'rove_aip_stage',
        { ...draft, skillName: 'overflow' },
        await revision(service),
        'web:one',
      ),
      /100/,
    );
    await service.execute(
      'rove_aip_stage',
      draft,
      await revision(service, 'web:other'),
      'web:other',
    );
    assert.equal((await service.list('web:other')).length, 1);
    const record = (await service.list('web:one'))[0];
    assert.ok(record);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: record.id },
        await revision(service),
        'web:one',
      ),
      /too large/,
    );
    assert.equal(requested, 1);
    assert.equal(
      (await service.list('web:one')).find((item) => item.id === record.id)
        ?.status,
      'draft',
    );
  } finally {
    service.close();
  }
});

test('conversation approvals activate a real immutable plugin and cannot be bypassed through the dashboard', async (t) => {
  const f = await fixture(t);
  let extensions = await createExtensions(f.config);
  let plugins = await createPlugins(f.config, extensions, f.fetchImpl);
  let service = await createAips(
    f.config,
    (skill) => plugins.activateRelease(skill),
    f.fetchImpl,
  );
  const runtime = {
    instructions: async () => await extensions.instructions(),
    tools: async (scope: string) => service.tools(scope),
    preview: async (
      name: string,
      args: Record<string, unknown>,
      scope: string,
    ) => await service.preview(name, args, scope),
    execute: (
      name: string,
      args: Record<string, unknown>,
      approvedRevision: string,
      scope: string,
      signal: AbortSignal,
    ) => service.execute(name, args, approvedRevision, scope, signal),
  };
  let chat = await createChat(f.config, runtime);
  let nextCall:
    | { name: string; arguments: Record<string, unknown> }
    | undefined;
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, 'Bearer dummy-model-key');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages: Array<{ role: string; content: string }>;
    };
    response.setHeader('Content-Type', 'application/json');
    if (nextCall) {
      const call = nextCall;
      nextCall = undefined;
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: randomUUID(),
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.arguments),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
    } else {
      const result = body.messages.at(-1)?.content ?? '';
      const status = result.startsWith('{')
        ? JSON.parse(result).status
        : 'unconfirmed';
      response.end(
        JSON.stringify({
          choices: [
            {
              message: { content: `AIP status: ${status}.` },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    }
  });
  try {
    await new Promise<void>((resolve) =>
      provider.listen(0, '127.0.0.1', resolve),
    );
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    await chat.saveSettings({
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      model: 'controlled-model',
      apiKey: 'dummy-model-key',
      systemPrompt: '',
    });
    await service.saveSettings(githubSettings);
    await plugins.saveSource({ ...githubSettings, approved: true });
    const conversation = await chat.create();
    const other = await chat.create();
    const scope = `web:${conversation.id}`;
    async function propose(name: string, args: Record<string, unknown>) {
      nextCall = { name: `rove_aip_${name}`, arguments: args };
      const result = await chat.send(conversation.id, {
        content: `Please ${name} the company improvement.`,
        requestId: randomUUID(),
      });
      assert.ok(result.pending);
      assert.equal(result.pending.status, 'waiting');
      assert.equal(result.pending.name, `rove_aip_${name}`);
      return result.pending;
    }
    async function approve(pending: { id: string }) {
      const result = await chat.decide(conversation.id, {
        approvalId: pending.id,
        decision: 'approve',
      });
      assert.equal(result.pending, undefined);
      return result;
    }
    await assert.rejects(
      propose('stage', oversizedDraft),
      /model provider did not return a text answer/,
    );
    assert.equal((await service.list(scope)).length, 0);
    assert.equal(f.calls.length, 0);
    let pending = await propose('stage', {
      ...draft,
      pluginPackage: {
        ...nativePackage,
        category: 'agent',
        execution: undefined,
        operations: [],
        capabilities: [],
        skills: [{ name: draft.skillName, markdown: draft.skillContent }],
        settings: [
          { key: 'tone', label: 'Tone', type: 'text', required: true },
        ],
      },
    });
    assert.equal((await service.list(scope)).length, 0);
    assert.equal(f.calls.length, 0);
    await approve(pending);
    const proposal = (await service.list(scope))[0];
    assert.ok(proposal);
    const target = { id: proposal.id };
    pending = await propose('publish', target);
    assert.equal((await service.list(scope))[0]?.status, 'draft');
    await approve(pending);
    await approve(await propose('inspect', target));
    f.merge();
    pending = await propose('review', { ...target, headSha: f.state.head });
    const preview = JSON.parse(pending.detail);
    assert.equal(preview.proposal.skillContent, draft.skillContent);
    assert.equal(preview.request.headSha, f.state.head);
    assert.equal((await service.list(scope))[0]?.review, undefined);

    // Preparing the same release in the dashboard must not bypass the waiting conversation review.
    await plugins.install({ repo: 'example/knowledge', tag: 'v1.0.0' });
    const installed = (await plugins.list()).installations[0];
    assert.ok(installed);
    const digest = installed.versions[0]?.digest;
    assert.ok(digest);
    const dashboardActivation = {
      id: installed.id,
      revision: installed.revision,
      digest,
    };
    await assert.rejects(
      plugins.activate(dashboardActivation),
      /originating conversation/,
    );
    assert.equal((await plugins.list()).installations[0]?.active, null);
    assert.doesNotMatch(await extensions.instructions(), /Read the source/);
    assert.equal((await chat.get(conversation.id)).pending?.id, pending.id);
    await approve(pending);
    assert.equal((await service.list(scope))[0]?.status, 'reviewed');
    await assert.rejects(
      plugins.activate(dashboardActivation),
      /originating conversation/,
    );

    pending = await propose('verify_release', { ...target, tag: 'v1.0.0' });
    assert.equal((await service.list(scope))[0]?.status, 'reviewed');
    await approve(pending);
    assert.equal((await service.list(scope))[0]?.status, 'verified');
    await assert.rejects(
      plugins.activate(dashboardActivation),
      /originating conversation/,
    );
    await assert.rejects(
      service.execute(
        'rove_aip_activate',
        target,
        await revision(service, scope),
        scope,
      ),
      /required setting/,
    );
    assert.equal((await plugins.list()).installations[0]?.active, null);
    await plugins.configure({
      ...dashboardActivation,
      values: { tone: 'Concise' },
      secrets: {},
      grants: [],
    });
    pending = await propose('activate', target);
    assert.equal((await plugins.list()).installations[0]?.active, null);
    await assert.rejects(
      chat.decide(
        conversation.id,
        { approvalId: pending.id, decision: 'approve' },
        'slack:unrelated',
      ),
      /not found/,
    );
    const result = await approve(pending);
    assert.equal(result.messages.length, 12);
    assert.match(result.messages.at(-1)?.content ?? '', /activated/);
    assert.equal((await service.list(scope))[0]?.status, 'activated');
    assert.equal((await service.list(scope))[0]?.scope, scope);
    assert.deepEqual(await service.list(`web:${other.id}`), []);
    assert.deepEqual((await chat.get(other.id)).messages, []);
    assert.equal((await plugins.list()).installations[0]?.active, digest);
    const managed = (await extensions.list()).skills.find(
      (entry) => entry.managedBy === installed.id,
    );
    assert.ok(managed);
    assert.equal(managed.markdown, draft.skillContent.trim());
    await assert.rejects(
      async () =>
        await extensions.adoptSkill({
          id: managed.id,
          name: managed.name,
          content: 'Unreviewed replacement',
          enabled: true,
        }),
      /Manage released/,
    );
    const db = f.config.db;
    const artifact = await db.get(
      'SELECT data FROM rove_plugin_artifact WHERE digest=$1',
      [digest],
    );
    assert.ok(artifact);
    assert.equal(JSON.parse(String(artifact.data)).bytes, f.state.manifest);

    const requests = f.calls.length;
    chat.close();
    service.close();
    plugins.close();
    extensions.close();
    extensions = await createExtensions(f.config);
    plugins = await createPlugins(f.config, extensions, f.fetchImpl);
    service = await createAips(
      f.config,
      (skill) => plugins.activateRelease(skill),
      f.fetchImpl,
    );
    chat = await createChat(f.config, runtime);
    assert.deepEqual(
      (await chat.get(conversation.id)).messages,
      result.messages,
    );
    assert.equal((await plugins.list()).installations[0]?.active, digest);
    assert.equal(
      (await extensions.list()).skills.find(
        (entry) => entry.managedBy === installed.id,
      )?.id,
      managed.id,
    );
    await service.execute(
      'rove_aip_activate',
      target,
      await revision(service, scope),
      scope,
    );
    assert.equal(f.calls.length, requests);
    assert.equal(
      (await plugins.list()).installations[0]?.audit.filter(
        (event) => event.event === 'activated',
      ).length,
      1,
    );
  } finally {
    chat.close();
    service.close();
    plugins.close();
    extensions.close();
    await new Promise<void>((resolve) => {
      provider.close(() => resolve());
      provider.closeAllConnections();
    });
  }
});
