import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from 'redis';
import { createRuntimeState } from '../src/runtime-state.js';
import { testConfig } from './storage.js';

test('Redis admits one core and records one active turn without its content', async (t) => {
  const config = await testConfig(t);
  const state = await createRuntimeState(config);
  t.after(() => state.close());
  await assert.rejects(createRuntimeState(config), /Another Rove core/);
  const client = createClient({ url: config.redisURL });
  client.on('error', () => {});
  await client.connect();
  t.after(() => client.destroy());
  let complete!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = state.withTurn(
    {
      kind: 'message',
      conversation: 'conversation-id',
      requestId: 'request-id',
    },
    async () => {
      entered();
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
  );
  await started;
  const saved = JSON.parse(
    String(await client.get(`${config.redisPrefix}:turn`)),
  );
  assert.equal(saved.conversation, 'conversation-id');
  assert.equal(saved.requestId, 'request-id');
  assert.deepEqual(Object.keys(saved).sort(), [
    'conversation',
    'id',
    'kind',
    'owner',
    'requestId',
    'startedAt',
  ]);
  assert.ok((await client.pTTL(`${config.redisPrefix}:turn`)) > 0);
  await assert.rejects(
    state.withTurn({ kind: 'approval' }, async () =>
      assert.fail('parallel turn'),
    ),
    /busy/,
  );
  complete();
  await pending;
  assert.equal(await client.get(`${config.redisPrefix}:turn`), null);
  await state.close();
  const restarted = await createRuntimeState(config);
  await restarted.health();
  await restarted.close();
});

test('Redis rate-limit increments are atomic and survive core restart', async (t) => {
  const config = await testConfig(t);
  let state = await createRuntimeState(config);
  t.after(() => state.close());
  const counts = await Promise.all(
    Array.from({ length: 11 }, () =>
      state.incrementWindow('/api/setup', 60_000),
    ),
  );
  assert.deepEqual(
    counts.sort((a, b) => a - b),
    Array.from({ length: 11 }, (_, i) => i + 1),
  );
  assert.equal(await state.incrementWindow('/api/recover', 60_000), 1);
  await state.close();
  state = await createRuntimeState(config);
  assert.equal(await state.incrementWindow('/api/setup', 60_000), 12);
});

test('Lost Redis ownership aborts work and cannot release a replacement owner', async (t) => {
  const config = await testConfig(t);
  const state = await createRuntimeState(config);
  t.after(() => state.close());
  const client = createClient({ url: config.redisURL });
  client.on('error', () => {});
  await client.connect();
  t.after(() => client.destroy());
  await client.set(`${config.redisPrefix}:owner`, 'replacement-owner', {
    PX: 30_000,
  });
  await assert.rejects(state.assertOwned(), /ownership was lost/);
  assert.equal(state.signal.aborted, true);
  await assert.rejects(
    state.withTurn({ kind: 'message' }, async () =>
      assert.fail('unowned execution'),
    ),
    /ownership is unavailable/,
  );
  await state.close();
  assert.equal(
    await client.get(`${config.redisPrefix}:owner`),
    'replacement-owner',
  );
});

test('Unavailable Redis refuses startup without an in-memory fallback', async (t) => {
  const config = await testConfig(t);
  await assert.rejects(
    createRuntimeState({ ...config, redisURL: 'redis://127.0.0.1:1' }),
    /Redis is unavailable/,
  );
});
