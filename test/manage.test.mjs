import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('management save and cancel restore keyboard focus and clear stale success feedback', async () => {
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
  const root = new Element('section');
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
  const source = await readFile('public/manage.js', 'utf8');
  const mount = runInNewContext(
    `${source.replace('export function', 'function')}; mountManage`,
    { document: { createElement: (tag) => new Element(tag) } },
  );
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
  assert.equal(focused.tag, 'h2');
  assert.equal(focused.textContent, 'Skills');
  assert.equal(
    root.querySelector('#manage-status').textContent,
    'Changes saved.',
  );
  button('Edit').onclick();
  assert.equal(root.querySelector('#manage-status').textContent, '');
  button('Cancel').onclick();
  assert.equal(focused.textContent, 'Skills');
  manager.dispose();
});
