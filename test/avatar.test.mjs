import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

// Exercise the real chat controller with a minimal DOM and a deferred reply.
test('avatar follows reply lifecycle, retries and disposal, not general loading', async () => {
  const elements = new Map();
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
    createElement: element,
  };
  let reply = Promise.withResolvers();
  const api = async (path) => {
    if (path === '/api/admin/settings') return { configured: true };
    if (path.endsWith('/messages')) return reply.promise;
    return { id: 'conversation', conversations: [], messages: [] };
  };
  const source = await readFile('public/chat.js', 'utf8');
  const mountChat = runInNewContext(
    `${source.replace('export function', 'function')}; mountChat`,
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
