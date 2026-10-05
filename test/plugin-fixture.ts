import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createExtensions } from '../src/extensions.js';
import { createPlugins } from '../src/plugins.js';
import { testRuntime } from './storage.js';

export const repo = 'example/company-agent';
export const manifest = (version = '1.0.0') => ({
  schemaVersion: 1,
  apiVersion: 1,
  id: 'company-agent',
  name: 'Company agent',
  version,
  category: 'agent',
  description: 'Company instructions',
  skills: [
    { name: 'Policy', markdown: `Policy ${version}. \${settings.tone}` },
  ],
  settings: [{ key: 'tone', label: 'Tone', type: 'text', required: true }],
});
export const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export async function fixture(t: TestContext) {
  const config = {
    ...(await testRuntime(t)),
    baseURL: 'http://localhost:3000',
    authSecret: 'plugin-test-secret-not-a-real-credential-123',
  };
  let extensions = await createExtensions(config);
  const state = {
    bytes: JSON.stringify(manifest()),
    onFetch: async () => {},
    calls: 0,
    assetId: 7,
    commit: 'a'.repeat(40),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    state.calls++;
    await state.onFetch();
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer dummy-github-token',
    );
    const url = new URL(String(input));
    if (url.pathname.includes('/releases/tags/'))
      return Response.json({
        tag_name: url.pathname.split('/').at(-1),
        draft: false,
        prerelease: false,
        assets: [
          {
            id: state.assetId,
            name: 'rove-plugin.json',
            state: 'uploaded',
            size: Buffer.byteLength(state.bytes),
            digest: `sha256:${hash(state.bytes)}`,
          },
        ],
      });
    if (url.pathname.includes('/git/ref/tags/'))
      return Response.json({ object: { type: 'commit', sha: state.commit } });
    if (url.pathname.endsWith('/contents/rove-plugin.json'))
      return Response.json({
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(state.bytes).toString('base64'),
      });
    if (url.pathname.endsWith(`/releases/assets/${state.assetId}`))
      return new Response(state.bytes);
    assert.fail(`Unexpected request ${url}`);
  };
  const env = { ROVE_PLUGIN_SECRET_ORDERS: 'environment-mcp-secret' };
  let plugins = await createPlugins(config, extensions, fetchImpl, env);
  t.after(() => {
    plugins.close();
    extensions.close();
  });
  return {
    config,
    state,
    env,
    get plugins() {
      return plugins;
    },
    get extensions() {
      return extensions;
    },
    async approve() {
      await plugins.saveSource({
        repo,
        approved: true,
        token: 'dummy-github-token',
      });
    },
    async install(pkg: unknown = manifest()) {
      state.bytes = JSON.stringify(pkg);
      await plugins.install({
        repo,
        tag: `v${(pkg as { version: string }).version}`,
      });
      return await current();
    },
    async restart() {
      plugins.close();
      extensions.close();
      extensions = await createExtensions(config);
      plugins = await createPlugins(config, extensions, fetchImpl, env);
    },
    current,
    async configure(
      grants: string[] = [],
      bindings: Record<string, unknown> = {},
    ) {
      const item = await current();
      await plugins.configure({
        id: item.id,
        revision: item.revision,
        digest: item.versions[0]?.digest,
        values: { tone: 'Be concise.' },
        secrets: bindings,
        grants,
      });
      return await current();
    },
    async activate(digest?: string) {
      const item = await current();
      return plugins.activate({
        id: item.id,
        revision: item.revision,
        digest: digest ?? item.versions[0]?.digest,
      });
    },
  };
  async function current() {
    const item = (await plugins.list()).installations[0];
    assert.ok(item);
    return item;
  }
}
