import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type AdoptedSkill, createAips } from '../src/aip.js';
import type { Config } from '../src/config.js';

const draft = {
  action: 'draft',
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
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rove-aip-'));
  const config: Config = {
    baseURL: 'http://localhost:3000',
    authSecret: 'test-auth-secret-'.repeat(4),
    databasePath: join(directory, 'rove.sqlite'),
  };
  const calls: Array<{
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  let merged = false;
  let mergedContent = draft.skillContent;
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
    assert.equal(init?.redirect, 'error');
    if (path === failAt) throw new TypeError('Connection lost after request');
    let result: unknown;
    if (path.endsWith('/pulls/42'))
      result = {
        merged,
        merge_commit_sha: 'merged-sha',
        base: { repo: { full_name: 'example/knowledge' } },
        head: { ref: branch },
      };
    else if (path.includes('/contents/')) {
      assert.equal(
        new URL(String(input)).searchParams.get('ref'),
        'merged-sha',
      );
      result = {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(mergedContent).toString('base64'),
      };
    } else if (path.endsWith('/git/ref/heads/main'))
      result = { object: { sha: 'base-sha' } };
    else if (path.endsWith('/git/commits/base-sha'))
      result = { tree: { sha: 'base-tree' } };
    else if (path.endsWith('/git/blobs')) result = { sha: 'skill-blob' };
    else if (path.endsWith('/git/trees')) result = { sha: 'skill-tree' };
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
    merge(content = draft.skillContent) {
      merged = true;
      mergedContent = content;
    },
    fail(path: string) {
      failAt = path;
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function revision(service: ReturnType<typeof createAips>, scope = 'web:one') {
  const tool = service.tools(scope)[0];
  assert.ok(tool);
  return tool.revision;
}

test('AIP drafts persist, preserve scope, invalidate approvals, and cancel without external calls', async () => {
  const f = fixture();
  let service = createAips(f.config, undefined, f.fetchImpl);
  try {
    assert.deepEqual(service.tools('web:one'), []);
    assert.throws(() =>
      service.saveSettings({ repo: 'example/..', token: 'dummy-github-token' }),
    );
    service.saveSettings({
      repo: 'example/knowledge',
      token: 'dummy-github-token',
    });
    assert.deepEqual(service.settings(), {
      repo: 'example/knowledge',
      configured: true,
    });
    assert.deepEqual(
      JSON.parse(service.preview('rove_aip_stage', draft, 'web:one')),
      { tool: 'rove_aip_stage', ...draft },
    );
    const initial = revision(service);
    const created = JSON.parse(
      await service.execute('rove_aip_stage', draft, initial, 'web:one'),
    );
    assert.equal(created.status, 'draft');
    const preview = JSON.parse(
      service.preview('rove_aip_publish', { id: created.id }, 'web:one'),
    );
    assert.equal(preview.destination, 'example/knowledge');
    assert.equal(preview.proposal.skillContent, draft.skillContent);
    assert.throws(
      () => service.preview('rove_aip_adopt', { id: created.id }, 'web:other'),
      /not found/,
    );
    assert.deepEqual(service.list('slack:other'), []);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        revision(service, 'slack:other'),
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
    const beforeRevision = revision(service);
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
      service.list('web:one')[0]?.summary,
      'Check sources and state any gaps.',
    );
    const beforeConfig = revision(service);
    service.saveSettings({ repo: 'example/knowledge', token: '' });
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
      revision(service),
      'web:one',
    );
    service.close();
    assert.equal(
      readFileSync(f.config.databasePath).includes(
        Buffer.from('dummy-github-token'),
      ),
      false,
    );
    service = createAips(f.config, undefined, f.fetchImpl);
    assert.equal(service.list('web:one')[0]?.status, 'cancelled');
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        revision(service),
        'web:one',
      ),
      /cannot be published/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    service.close();
    f.cleanup();
  }
});

test('approved AIP creates one draft PR and adopts only the exact merged skill', async () => {
  const f = fixture();
  const adopted: AdoptedSkill[] = [];
  let service = createAips(
    f.config,
    (skill) => {
      adopted.push(skill);
    },
    f.fetchImpl,
  );
  try {
    service.saveSettings({
      repo: 'example/knowledge',
      token: 'dummy-github-token',
    });
    const created = JSON.parse(
      await service.execute(
        'rove_aip_stage',
        draft,
        revision(service),
        'web:one',
      ),
    );
    const published = JSON.parse(
      await service.execute(
        'rove_aip_publish',
        { id: created.id },
        revision(service),
        'web:one',
      ),
    );
    assert.equal(published.status, 'published');
    assert.equal(published.url, 'https://github.com/example/knowledge/pull/42');
    const pr = f.calls.find((call) => call.path.endsWith('/pulls'));
    assert.equal(pr?.body?.draft, true);
    assert.equal(pr?.body?.base, 'main');
    assert.equal(pr?.body?.head, `rove/aip-${created.id}`);
    assert.equal(
      f.calls.find((call) => call.path.endsWith('/git/blobs'))?.body?.content,
      draft.skillContent,
    );
    assert.deepEqual(
      f.calls.find((call) => call.path.endsWith('/git/trees'))?.body?.tree,
      [
        {
          path: '.rove/skills/verify-evidence.md',
          mode: '100644',
          type: 'blob',
          sha: 'skill-blob',
        },
      ],
    );
    assert.doesNotMatch(String(pr?.body?.body), /web:one/);
    await assert.rejects(
      service.execute(
        'rove_aip_adopt',
        { id: created.id },
        revision(service),
        'web:one',
      ),
      /not verified as merged/,
    );
    f.merge('# Unreviewed replacement');
    await assert.rejects(
      service.execute(
        'rove_aip_adopt',
        { id: created.id },
        revision(service),
        'web:one',
      ),
      /differs/,
    );
    assert.equal(adopted.length, 0);
    f.merge();
    const result = JSON.parse(
      await service.execute(
        'rove_aip_adopt',
        { id: created.id },
        revision(service),
        'web:one',
      ),
    );
    assert.equal(result.status, 'adopted');
    assert.deepEqual(adopted, [
      {
        id: created.id,
        name: draft.skillName,
        content: draft.skillContent,
        enabled: true,
      },
    ]);
    const count = f.calls.length;
    service.close();
    service = createAips(
      f.config,
      () => assert.fail('Adoption must not replay'),
      f.fetchImpl,
    );
    await service.execute(
      'rove_aip_publish',
      { id: created.id },
      revision(service),
      'web:one',
    );
    await service.execute(
      'rove_aip_adopt',
      { id: created.id },
      revision(service),
      'web:one',
    );
    assert.equal(f.calls.length, count);
  } finally {
    service.close();
    f.cleanup();
  }
});

test('an unknown GitHub outcome remains blocked after restart and cannot duplicate a PR', async () => {
  const f = fixture();
  let service = createAips(f.config, undefined, f.fetchImpl);
  try {
    service.saveSettings({
      repo: 'example/knowledge',
      token: 'dummy-github-token',
    });
    const created = JSON.parse(
      await service.execute(
        'rove_aip_stage',
        draft,
        revision(service),
        'web:one',
      ),
    );
    f.fail('/repos/example/knowledge/pulls');
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        revision(service),
        'web:one',
      ),
      /Connection lost/,
    );
    assert.equal(service.list('web:one')[0]?.status, 'uncertain');
    assert.equal(service.list('web:one')[0]?.branch, `rove/aip-${created.id}`);
    const count = f.calls.length;
    service.close();
    service = createAips(f.config, undefined, f.fetchImpl);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: created.id },
        revision(service),
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
        revision(service),
        'web:one',
        controller.signal,
      ),
      /cancelled/,
    );
  } finally {
    service.close();
    f.cleanup();
  }
});

test('AIP skill, scope storage, and GitHub response bounds fail before writes', async () => {
  const f = fixture();
  let requested = 0;
  const service = createAips(f.config, undefined, async () => {
    requested++;
    return new Response('x'.repeat(256001));
  });
  try {
    service.saveSettings({
      repo: 'example/knowledge',
      token: 'dummy-github-token',
    });
    await assert.rejects(
      service.execute(
        'rove_aip_stage',
        { ...draft, skillContent: 'x'.repeat(8001) },
        revision(service),
        'web:one',
      ),
    );
    assert.equal(service.list('web:one').length, 0);
    for (let index = 0; index < 100; index++) {
      await service.execute(
        'rove_aip_stage',
        { ...draft, skillName: `evidence-${index}` },
        revision(service),
        'web:one',
      );
    }
    assert.equal(service.list('web:one').length, 100);
    await assert.rejects(
      service.execute(
        'rove_aip_stage',
        { ...draft, skillName: 'overflow' },
        revision(service),
        'web:one',
      ),
      /100/,
    );
    await service.execute(
      'rove_aip_stage',
      draft,
      revision(service, 'web:other'),
      'web:other',
    );
    assert.equal(service.list('web:other').length, 1);
    const record = service.list('web:one')[0];
    assert.ok(record);
    await assert.rejects(
      service.execute(
        'rove_aip_publish',
        { id: record.id },
        revision(service),
        'web:one',
      ),
      /too large/,
    );
    assert.equal(requested, 1);
    assert.equal(
      service.list('web:one').find((item) => item.id === record.id)?.status,
      'draft',
    );
  } finally {
    service.close();
    f.cleanup();
  }
});
