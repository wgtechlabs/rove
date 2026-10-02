import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decodedFile, loadRelease } from '../src/aip-release.js';

function fixture() {
  const commit = 'a'.repeat(40);
  const bytes = `${JSON.stringify({ schemaVersion: 1, apiVersion: 1, id: 'evidence', name: 'Evidence', version: '1.0.0', category: 'agent', description: 'Source checks', skills: [{ name: 'Evidence', markdown: 'Check the source.' }] })}\n`;
  const state = {
    source: bytes,
    sourceBase64: null as string | null,
    asset: bytes,
    assetSize: Buffer.byteLength(bytes),
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    redirect: '',
    tagged: false,
    tagDepth: 0,
    workflowConclusion: 'success',
  };
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: new Headers(init?.headers) });
    assert.ok(init?.signal);
    if (url.hostname !== 'api.github.com') {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.equal(init?.redirect, 'error');
      return new Response(state.asset);
    }
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer dummy-token',
    );
    if (url.pathname.endsWith('/releases/tags/v1.0.0'))
      return Response.json({
        tag_name: 'v1.0.0',
        draft: false,
        prerelease: false,
        assets: [
          {
            id: 7,
            name: 'rove-plugin.json',
            state: 'uploaded',
            size: state.assetSize,
            digest: state.digest,
          },
        ],
      });
    if (url.pathname.endsWith('/git/ref/tags/v1.0.0'))
      return Response.json({
        object: { type: state.tagged ? 'tag' : 'commit', sha: commit },
      });
    if (url.pathname.includes('/git/tags/')) {
      state.tagDepth++;
      return Response.json({
        object: { type: state.tagDepth < 2 ? 'tag' : 'commit', sha: commit },
      });
    }
    if (url.pathname.endsWith('/contents/rove-plugin.json')) {
      assert.equal(url.searchParams.get('ref'), commit);
      return Response.json({
        type: 'file',
        encoding: 'base64',
        content:
          state.sourceBase64 ?? Buffer.from(state.source).toString('base64'),
      });
    }
    if (url.pathname.endsWith('/releases/assets/7')) {
      assert.equal(init?.redirect, 'manual');
      assert.equal(
        new Headers(init?.headers).get('Accept'),
        'application/octet-stream',
      );
      return state.redirect
        ? new Response(null, {
            status: 302,
            headers: { Location: state.redirect },
          })
        : new Response(state.asset);
    }
    assert.fail(`Unexpected request ${url}`);
  };
  return { state, calls, fetchImpl, commit };
}

const request = {
  repo: 'example/plugins',
  tag: 'v1.0.0',
  token: 'dummy-token',
};

test('release loader pins committed bytes and follows only credential-free GitHub asset redirects', async () => {
  const f = fixture();
  f.state.tagged = true;
  f.state.redirect =
    'https://release-assets.githubusercontent.com/company/asset?signature=test';
  const result = await loadRelease(request, f.fetchImpl);
  assert.equal(result.commit, f.commit);
  assert.equal(result.assetId, 7);
  assert.equal(result.manifest.id, 'evidence');
  assert.equal(result.bytes, f.state.source);
  assert.equal(result.digest, f.state.digest.slice(7));
  assert.equal(f.state.tagDepth, 2);
  assert.equal(f.calls.at(-1)?.headers.has('Authorization'), false);
  for (const redirect of [
    'https://attacker.example/asset',
    'https://release-assets.githubusercontent.com.attacker.example/asset',
    'http://release-assets.githubusercontent.com/asset',
    'https://user:password@release-assets.githubusercontent.com/asset',
    'https://release-assets.githubusercontent.com:8443/asset',
  ]) {
    f.state.redirect = redirect;
    const before = f.calls.filter(
      (call) => new URL(call.url).hostname !== 'api.github.com',
    ).length;
    await assert.rejects(loadRelease(request, f.fetchImpl), /untrusted/);
    assert.equal(
      f.calls.filter((call) => new URL(call.url).hostname !== 'api.github.com')
        .length,
      before,
    );
  }
});

test('release loader rejects tampered digest, source and oversized bytes before installation', async () => {
  const f = fixture();
  f.state.digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(loadRelease(request, f.fetchImpl), /differs/);
  f.state.digest = '';
  f.state.source = f.state.asset.replace(
    'Check the source.',
    'Do something else.',
  );
  await assert.rejects(loadRelease(request, f.fetchImpl), /differs/);
  f.state.source = f.state.asset;
  f.state.asset = 'x'.repeat(256001);
  await assert.rejects(loadRelease(request, f.fetchImpl), /too large/);
  f.state.assetSize = 256001;
  await assert.rejects(loadRelease(request, f.fetchImpl), /bounded/);
});

test('release loader validates identity and compatibility without trusting package-declared checksums', async () => {
  const f = fixture();
  await assert.rejects(
    loadRelease({ ...request, repo: 'example/..' }, f.fetchImpl),
  );
  await assert.rejects(
    loadRelease({ ...request, tag: '../../main' }, f.fetchImpl),
  );
  await assert.rejects(
    loadRelease({ ...request, token: 'dummy\nheader' }, f.fetchImpl),
    /Invalid GitHub token/,
  );
  assert.equal(f.calls.length, 0);
  const invalid = JSON.parse(f.state.asset);
  invalid.apiVersion = 99;
  f.state.source = f.state.asset = JSON.stringify(invalid);
  f.state.assetSize = Buffer.byteLength(f.state.asset);
  f.state.digest = '';
  await assert.rejects(
    loadRelease(request, f.fetchImpl),
    /package|manifest|API/i,
  );
});

test('source decoding preserves bytes and rejects malformed base64 or UTF-8 before verifying a release', async () => {
  const file = (content: string) => ({
    type: 'file',
    encoding: 'base64',
    content,
  });
  const text = '\uFEFFExact source text';
  const wrapped = Buffer.from(text)
    .toString('base64')
    .replace(/(.{4})/g, '$1\n');
  assert.equal(decodedFile(file(wrapped)), text);
  for (const encoded of [
    '%%%%',
    'Zh==',
    'Zg',
    Buffer.from([255]).toString('base64'),
  ]) {
    assert.throws(() => decodedFile(file(encoded)), /invalid base64 or UTF-8/);
  }

  const f = fixture();
  f.state.asset = f.state.asset.replace('Check the source.', '\uFFFD');
  const asset = Buffer.from(f.state.asset);
  const at = asset.indexOf(Buffer.from('\uFFFD'));
  const malformed = Buffer.concat([
    asset.subarray(0, at),
    Buffer.from([255]),
    asset.subarray(at + 3),
  ]);
  assert.notDeepEqual(malformed, asset);
  f.state.sourceBase64 = malformed.toString('base64');
  f.state.assetSize = asset.length;
  f.state.digest = `sha256:${createHash('sha256').update(asset).digest('hex')}`;
  await assert.rejects(
    loadRelease(request, f.fetchImpl),
    /invalid base64 or UTF-8/,
  );
});
