import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function dom() {
  let focused;
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.textContent = '';
      this.value = '';
    }
    append(...children) {
      this.children.push(...children);
    }
    prepend(child) {
      this.children.unshift(child);
    }
    replaceChildren(...children) {
      this.children = children;
    }
    setAttribute() {}
    focus() {
      focused = this;
    }
    querySelector(selector) {
      return this.all().find((el) =>
        selector.startsWith('#')
          ? el.id === selector.slice(1)
          : el.tag === selector,
      );
    }
    all() {
      return this.children.flatMap((child) => [child, ...child.all()]);
    }
    set innerHTML(_value) {
      this.replaceChildren();
      for (const [tag, id] of [
        ['h1', ''],
        ['button', 'manage-back'],
        ['nav', ''],
        ['p', 'manage-status'],
        ['div', 'manage-content'],
      ]) {
        const child = new Element(tag);
        child.id = id;
        this.append(child);
      }
    }
  }
  return { Element, root: new Element('section'), focused: () => focused };
}
async function management(Element) {
  const source = await readFile('public/manage.js', 'utf8');
  const plugins = await readFile('public/plugins.js', 'utf8');
  const pages = await readFile('public/plugin-pages.js', 'utf8');
  return runInNewContext(
    `${plugins.replace('export function', 'function')}\n${pages.replace('export function', 'function')}\n${source.replace(/^import[^\n]*\n/gm, '').replace('export function', 'function')}; mountManage`,
    { document: { createElement: (tag) => new Element(tag) } },
  );
}

test('management save and cancel restore keyboard focus and clear stale success feedback', async () => {
  const { Element, root, focused } = dom();
  let saved = [];
  let pending;
  const api = async (_path, body) => {
    if (body) saved = [{ ...body, id: 'test-skill' }];
    return { skills: saved, plugins: [], servers: [] };
  };
  const run = (action) => {
    pending = action();
    return pending;
  };
  const mount = await management(Element);
  const manager = mount(root, api, run, () => {});
  await manager.load();
  const button = (text) =>
    root.all().find((el) => el.tag === 'button' && el.textContent === text);
  button('Add skill').onclick();
  root.querySelector('#manage-name').value = 'Handoffs';
  root.querySelector('#manage-markdown').value = 'Name the next owner.';
  root.querySelector('form').onsubmit({ preventDefault() {} });
  await pending;
  assert.equal(saved[0].markdown, 'Name the next owner.');
  assert.equal(focused().tag, 'h2');
  assert.equal(focused().textContent, 'Skills');
  assert.equal(
    root.querySelector('#manage-status').textContent,
    'Changes saved.',
  );
  button('Edit').onclick();
  assert.equal(root.querySelector('#manage-status').textContent, '');
  button('Cancel').onclick();
  assert.equal(focused().textContent, 'Skills');
  manager.dispose();
});

test('plugin management keeps package text inert and saves explicit grants before separate version activation', async () => {
  const { Element, root, focused } = dom();
  const digest = 'a'.repeat(64);
  const previous = 'b'.repeat(64);
  const manifest = {
    name: '<img src=x onerror=alert(1)>',
    version: '1.0.0',
    category: 'channel',
    channel: { outgoing: { url: 'https://integration.example/reply' } },
    description: 'An internal test package',
    skills: [{ name: 'Read me', markdown: '<script>untrusted</script>' }],
    instructions: '',
    settings: [
      { key: 'company', label: 'Company name', type: 'text', required: true },
    ],
    secrets: [{ key: 'token', label: 'MCP credential', required: true }],
    servers: [
      { id: 'read', name: 'Knowledge', url: 'https://tools.example/mcp' },
    ],
    capabilities: ['mcp:read', 'channel:ingress', 'channel:delivery'],
  };
  const installation = {
    id: 'installation-id',
    repo: 'example/plugins',
    pluginId: 'knowledge',
    active: null,
    revision: 'revision-one',
    values: {},
    grants: [],
    secrets: {},
    audit: [],
    versions: [
      {
        manifest,
        digest,
        tag: 'v1.0.0',
        commit: 'c'.repeat(40),
        blocked: null,
        origin: {
          format: 'claude-code',
          sourceDigest: 'e'.repeat(64),
          metadata: {
            license: 'MIT',
            author: {
              name: '<img src=x onerror=alert(1)>',
              email: 'author@example.com',
              url: 'https://example.com/author',
            },
            homepage: 'https://example.com',
            repository: 'https://github.com/example/plugins',
            notices: [
              {
                path: 'LICENSE',
                text: '<script>License text stays inert.</script>',
              },
            ],
          },
        },
      },
      {
        manifest: { ...manifest, version: '0.9.0' },
        digest: previous,
        tag: 'v0.9.0',
        commit: 'd'.repeat(40),
        blocked: null,
      },
    ],
  };
  const releases = installation.versions;
  installation.versions = releases.map(({ digest, tag, manifest }) => ({
    digest,
    tag,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    version: manifest.version,
  }));
  const state = {
    sources: [{ repo: 'example/plugins', approved: true, configured: true }],
    installations: [installation],
    executable: { reason: 'Executable plugins are unavailable.' },
  };
  const writes = [];
  const detailRequests = [];
  let failDetail = false;
  let expired = false;
  const failures = [];
  let heldDetail;
  let pending;
  const run = (action) => {
    pending = action();
    return pending;
  };
  const api = async (path, body) => {
    if (path.includes('/releases/')) {
      detailRequests.push(path);
      if (expired)
        throw Object.assign(new Error('Sign in again.'), { status: 401 });
      if (failDetail)
        throw new Error('Version details are temporarily unavailable. Retry.');
      if (heldDetail && path.endsWith(digest)) await heldDetail;
      return releases.find((release) => path.endsWith(release.digest));
    }
    if (body) {
      writes.push({ path, body: JSON.parse(JSON.stringify(body)) });
      if (path.endsWith('/configure')) {
        installation.values = body.values;
        installation.grants = body.grants;
        installation.secrets = {
          token: {
            source: 'environment',
            name: body.secrets.token.name,
            configured: true,
          },
        };
        installation.revision = 'revision-two';
      }
      if (path.endsWith('/activate')) installation.active = body.digest;
    }
    if (path === '/api/admin/extensions')
      return { skills: [], plugins: [], servers: [] };
    if (path === '/api/admin/runtime')
      return { configured: false, pendingCleanup: [] };
    if (path.endsWith('/channel'))
      return { state: 'ready', jobs: [{ status: 'uncertain', count: 1 }] };
    return state;
  };
  const manager = (await management(Element))(
    root,
    api,
    run,
    () => {},
    undefined,
    (error) => failures.push(error),
  );
  await manager.load();
  const button = (text) =>
    root
      .all()
      .find(
        (element) => element.tag === 'button' && element.textContent === text,
      );
  button('Plugins').onclick();
  await pending;
  assert.equal(
    detailRequests.length,
    0,
    'listing installed plugins must not fetch artifact content',
  );
  const details = root
    .all()
    .find(
      (element) =>
        element.tag === 'details' &&
        element.children[0]?.textContent === 'Review versions and settings',
    );
  details.open = true;
  await details.ontoggle();
  assert.deepEqual(detailRequests, [
    `/api/admin/plugins/installation-id/releases/${digest}`,
  ]);
  assert.equal(
    root
      .all()
      .some((element) => element.tag === 'img' || element.tag === 'script'),
    false,
  );
  assert.ok(
    root.all().some((element) => element.textContent === manifest.name),
  );
  assert.ok(
    root
      .all()
      .some((element) => element.textContent === 'Publisher and license'),
  );
  assert.ok(
    root
      .all()
      .some(
        (element) =>
          element.textContent ===
            '<script>License text stays inert.</script>' &&
          element.tag === 'pre',
      ),
  );
  const grant = root.querySelector('#manage-grant-installation-id-mcp-read');
  assert.equal(grant.checked, false);
  root.querySelector('#manage-channel-installation-id-tenant').value =
    'workspace-1';
  root.querySelector('#manage-channel-installation-id-users').value =
    'member-1\nadmin-1\nmember-1';
  root.querySelector('#manage-channel-installation-id-admins').value =
    'admin-1';
  root.querySelector('#manage-channel-installation-id-destinations').value =
    'room-1';
  button('Check channel deliveries').onclick();
  await pending;
  assert.ok(
    root.all().some((element) => element.textContent === '1 uncertain'),
  );
  const company = root.querySelector('#manage-plugin-installation-id-company');
  company.value = 'Example company';
  const form = root
    .all()
    .find(
      (element) => element.tag === 'form' && element.all().includes(company),
    );
  form.oninput();
  assert.equal(button('Activate selected version').disabled, true);
  assert.equal(button('Activate selected version').dataset.unavailable, 'true');
  const mode = root.querySelector('#manage-secret-installation-id-token-mode');
  const environment = root.querySelector(
    '#manage-secret-installation-id-token-name',
  );
  assert.equal(environment.disabled, true);
  mode.value = 'environment';
  mode.onchange();
  assert.equal(environment.disabled, false);
  environment.value = 'invalid variable name';
  mode.value = 'keep';
  mode.onchange();
  assert.equal(environment.disabled, true);
  assert.equal(environment.dataset.unavailable, 'true');
  mode.value = 'environment';
  mode.onchange();
  environment.value = 'ROVE_PLUGIN_SECRET_KNOWLEDGE';
  grant.checked = true;
  form.onsubmit({ preventDefault() {} });
  await pending;
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    path: '/api/admin/plugins/configure',
    body: {
      id: 'installation-id',
      revision: 'revision-one',
      digest,
      values: { company: 'Example company' },
      grants: ['mcp:read'],
      channelAccess: {
        tenant: 'workspace-1',
        users: ['member-1', 'admin-1'],
        admins: ['admin-1'],
        destinations: ['room-1'],
      },
      secrets: {
        token: { source: 'environment', name: 'ROVE_PLUGIN_SECRET_KNOWLEDGE' },
      },
    },
  });
  assert.equal(installation.active, null);
  button('Activate selected version').onclick();
  await pending;
  assert.deepEqual(writes[1], {
    path: '/api/admin/plugins/activate',
    body: { id: 'installation-id', revision: 'revision-two', digest },
  });
  assert.equal(focused().textContent, 'Plugins');
  const version = root.querySelector('#manage-version-installation-id');
  version.value = previous;
  failDetail = true;
  await version.onchange();
  assert.equal(
    button('Activate selected version'),
    undefined,
    'failed detail reads must not leave a stale activation control',
  );
  failDetail = false;
  await button('Retry version details').onclick();
  let finishDetail;
  heldDetail = new Promise((resolve) => {
    finishDetail = resolve;
  });
  version.value = digest;
  const staleDetail = version.onchange();
  version.value = previous;
  await version.onchange();
  finishDetail();
  await staleDetail;
  assert.equal(
    root.all().some((element) => element.textContent === 'c'.repeat(40)),
    false,
    'late responses must not replace the selected release',
  );
  button('Activate selected version').onclick();
  await pending;
  assert.equal(writes[2].body.digest, previous);
  button('Edit repository').onclick();
  assert.equal(focused().id, 'manage-source-repo');
  assert.equal(root.querySelector('#manage-source-token').value, '');
  expired = true;
  const expiredVersion = root.querySelector('#manage-version-installation-id');
  expiredVersion.value = digest;
  await expiredVersion.onchange();
  assert.equal(failures.length, 1);
  assert.equal(
    failures[0].status,
    401,
    'lazy reads must forward expiry to the workspace handler',
  );
  assert.equal(button('Retry version details'), undefined);
  manager.dispose();
});

test('managed extensions cannot be edited locally and new repositories are not preapproved', async () => {
  const { Element, root } = dom();
  let pending;
  const run = (action) => {
    pending = action();
    return pending;
  };
  const api = async (path) => {
    if (path === '/api/admin/extensions')
      return {
        skills: [
          {
            id: 'managed',
            name: 'Owned workflow',
            managedBy: 'installation-id',
            enabled: true,
          },
        ],
        servers: [],
        plugins: [],
      };
    if (path === '/api/admin/runtime')
      return { configured: false, pendingCleanup: [] };
    return {
      sources: [],
      installations: [],
      executable: { reason: 'Unavailable' },
    };
  };
  const manager = (await management(Element))(root, api, run, () => {});
  await manager.load();
  const button = (text) =>
    root
      .all()
      .find(
        (element) => element.tag === 'button' && element.textContent === text,
      );
  assert.equal(button('Edit'), undefined);
  button('Open Plugins').onclick();
  await pending;
  assert.equal(root.querySelector('#manage-source-approved').checked, false);
  assert.equal(button('Prepare release'), undefined);
  manager.dispose();
});

test('plugin pages keep content inert and route reviewed JSON with the displayed revision', async () => {
  const { Element, root, focused } = dom();
  let pending;
  const requests = [];
  const paths = [];
  const action = {
    name: 'rove_plugin_example',
    label: 'Prepare a report',
    description: '<img src=x onerror=alert(1)>',
    revision: 'revision-one',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  };
  const api = async (path) => {
    paths.push(path);
    if (path === '/api/admin/extensions')
      return { skills: [], plugins: [], servers: [] };
    return {
      plugins: [
        {
          id: 'company',
          name: '<script>Company</script>',
          pages: [
            {
              id: 'reports',
              title: 'Reports',
              content: '<script>document.cookie</script>\nCompany guidance.',
              actions: [action.name],
            },
          ],
          actions: [action],
        },
      ],
    };
  };
  const manager = (await management(Element))(
    root,
    api,
    (work) => {
      pending = work();
      return pending;
    },
    () => {},
    async (request) => {
      requests.push(JSON.parse(JSON.stringify(request)));
    },
  );
  await manager.load();
  const button = (text) =>
    root.all().find((el) => el.tag === 'button' && el.textContent === text);
  button('Pages & actions').onclick();
  await pending;
  assert.deepEqual(paths, [
    '/api/admin/extensions',
    '/api/admin/plugins/contributions',
  ]);
  assert.ok(
    root
      .all()
      .some(
        (el) =>
          el.textContent ===
          '<script>document.cookie</script>\nCompany guidance.',
      ),
  );
  assert.equal(
    root.all().some((el) => ['script', 'img'].includes(el.tag)),
    false,
  );
  const opener = button(action.label);
  opener.onclick();
  assert.equal(focused().textContent, action.label);
  const args = root.querySelector('#manage-action-company');
  assert.equal(args.value, '{}');
  assert.ok(
    root
      .all()
      .some((el) => el.tag === 'pre' && el.textContent.includes('"required"')),
  );
  const submit = () =>
    root.querySelector('form').onsubmit({ preventDefault() {} });
  args.value = '[]';
  submit();
  await assert.rejects(pending, /must be a JSON object/);
  assert.equal(requests.length, 0);
  args.value = '{"title":"A report"}';
  args.oninput();
  button('Close action').onclick();
  assert.equal(focused(), opener);
  opener.onclick();
  assert.equal(root.querySelector('#manage-action-company').value, args.value);
  submit();
  await pending;
  assert.deepEqual(requests, [
    {
      name: action.name,
      revision: action.revision,
      arguments: { title: 'A report' },
    },
  ]);
  manager.dispose();
});
