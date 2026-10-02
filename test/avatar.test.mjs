import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

// Exercise the real chat controller with a minimal DOM and a deferred reply.
test('avatar follows reply lifecycle, retries and disposal, not general loading', async () => {
  const elements = new Map();
  const created = [];
  const element = () => ({
    dataset: {},
    value: '',
    textContent: '',
    setAttribute() {},
    replaceChildren() {},
    append() {},
    focus() {},
    scrollIntoView() {},
  });
  const find = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const main = {
    ...element(),
    querySelector: find,
    querySelectorAll: () => [],
  };
  const avatar = element();
  const document = {
    querySelector: () => avatar,
    createElement: () => {
      const node = element();
      created.push(node);
      return node;
    },
  };
  let reply = Promise.withResolvers();
  const api = async (path) => {
    if (path === '/api/admin/settings') return { configured: true };
    if (path.endsWith('/messages') || path.endsWith('/approval'))
      return reply.promise;
    return { id: 'conversation', conversations: [], messages: [] };
  };
  const source = await readFile('public/chat.js', 'utf8');
  const mountChat = runInNewContext(
    `${source.replace(/^import .*;\n/, '').replace('export function', 'function')}; mountChat`,
    { document, crypto, requestAnimationFrame: (callback) => callback() },
  );
  const dispose = mountChat(main, {}, api, () => {}, element());
  assert.equal(avatar.dataset.expression, 'idle');
  await setImmediate();
  find('#message').value = 'Hello';
  const submit = () => find('#composer').onsubmit({ preventDefault() {} });
  submit();
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'thinking');
  assert.match(find('#send-status').textContent, /Waiting for Rove/);

  reply.reject(new Error('Provider unavailable'));
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'unsure');
  assert.equal(find('#workspace-error').textContent, 'Provider unavailable');
  assert.equal(find('#send-message').textContent, 'Retry message');
  assert.equal(find('#message').value, 'Hello');

  find('#settings-open').onclick();
  assert.equal(avatar.dataset.expression, 'idle');
  find('#settings-close').onclick();
  reply = Promise.withResolvers();
  submit();
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'thinking');
  reply.resolve({ id: 'conversation', messages: [] });
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'idle');
  assert.equal(find('#send-status').textContent, '');

  find('#message').value = 'Propose an action';
  reply = Promise.withResolvers();
  submit();
  await setImmediate();
  reply.resolve({
    id: 'conversation',
    messages: [],
    pending: {
      id: 'approval',
      status: 'waiting',
      name: 'test_tool',
      arguments: {},
    },
  });
  await setImmediate();
  const approve = created.findLast(
    (node) => node.textContent === 'Approve this action',
  );
  assert.ok(approve);
  reply = Promise.withResolvers();
  approve.onclick();
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'thinking');
  reply.reject(new Error('Approval expired'));
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'unsure');
  assert.equal(find('#workspace-error').textContent, 'Approval expired');
  reply = Promise.withResolvers();
  approve.onclick();
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'thinking');
  reply.resolve({ id: 'conversation', messages: [] });
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'idle');

  find('#message').value = 'Another message';
  reply = Promise.withResolvers();
  submit();
  await setImmediate();
  dispose();
  assert.equal(avatar.dataset.expression, 'idle');
  reply.reject(new Error('Late failure'));
  await setImmediate();
  assert.equal(avatar.dataset.expression, 'idle');
});

test('plugin actions work without a model and retry the same conversation and request after a lost response', async () => {
  const elements = new Map();
  const created = [];
  const element = () => ({
    dataset: {},
    value: '',
    textContent: '',
    setAttribute() {},
    replaceChildren() {},
    append() {},
    focus() {},
  });
  const find = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const main = {
    ...element(),
    querySelector: find,
    querySelectorAll: () => [],
  };
  find('#manage-view').querySelector = find;
  const avatar = element();
  let invokeAction;
  let reportFailure;
  let expirations = 0;
  const action = {
    name: 'rove_plugin_example',
    revision: 'revision-one',
    arguments: { title: 'Report' },
  };
  let response = Promise.withResolvers();
  const writes = [];
  const api = async (path, body) => {
    if (path === '/api/admin/settings') return { configured: false };
    if (path.endsWith('/actions')) {
      writes.push({ path, body });
      return response.promise;
    }
    if (path === '/api/admin/conversations')
      return body
        ? { id: 'target', messages: [] }
        : { conversations: [{ id: 'other', title: 'Other chat' }] };
    if (path === '/api/admin/conversations/other')
      return { id: 'other', title: 'Other chat', messages: [] };
    throw new Error(`Unexpected call: ${path}`);
  };
  const source = await readFile('public/chat.js', 'utf8');
  const mount = runInNewContext(
    `${source.replace(/^import .*;\n/, '').replace('export function', 'function')}; mountChat`,
    {
      document: {
        querySelector: () => avatar,
        createElement: () => {
          const node = element();
          created.push(node);
          return node;
        },
      },
      crypto,
      requestAnimationFrame: (callback) => callback(),
      mountManage: (_root, _api, run, _back, requestAction, onError) => {
        invokeAction = () => run(() => requestAction(action));
        reportFailure = onError;
        return { async load() {}, dispose() {} };
      },
    },
  );
  const dispose = mount(
    main,
    {},
    api,
    () => {
      expirations++;
    },
    element(),
  );
  await setImmediate();
  assert.equal(find('#composer').hidden, true);
  find('#manage-open').onclick();
  await setImmediate();
  invokeAction();
  invokeAction();
  await setImmediate();
  assert.equal(writes.length, 1);
  response.reject(new Error('Lost response'));
  await setImmediate();
  assert.equal(find('#workspace-error').textContent, 'Lost response');
  created.findLast((node) => node.textContent === 'Other chat').onclick();
  await setImmediate();
  find('#manage-open').onclick();
  await setImmediate();
  response = Promise.withResolvers();
  invokeAction();
  await setImmediate();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(writes[1].path, '/api/admin/conversations/target/actions');
  assert.equal(writes[1].body.revision, 'revision-one');
  response.resolve({
    id: 'target',
    title: 'Report action',
    messages: [],
    pending: {
      id: 'approval',
      status: 'waiting',
      name: action.name,
      arguments: action.arguments,
    },
  });
  await setImmediate();
  assert.equal(find('#chat-view').hidden, false);
  assert.equal(find('#chat-empty').hidden, true);
  assert.equal(find('#composer').hidden, true);
  assert.ok(
    created.findLast((node) => node.textContent === 'Approve this action'),
  );
  assert.equal(find('#workspace-error').textContent, '');
  response = Promise.withResolvers();
  invokeAction();
  await setImmediate();
  reportFailure({ status: 401 });
  assert.equal(
    expirations,
    1,
    'a lazy-read expiry must work while another action is busy',
  );
  dispose();
  reportFailure({ status: 401 });
  assert.equal(expirations, 1, 'disposed workspaces ignore late failures');
  response.resolve({ id: 'target', messages: [] });
  await setImmediate();
});
