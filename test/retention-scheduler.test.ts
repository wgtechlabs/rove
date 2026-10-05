import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createRetentionScheduler,
  retentionWindow,
} from '../src/retention-scheduler.js';
import { testRuntime } from './storage.js';

test('retention runs once per UTC day at 04:00 and catches up after restart', async (t) => {
  const runtime = await testRuntime(t);
  let calls = 0;
  const now = Date.UTC(2026, 9, 5, 4);
  assert.equal(retentionWindow(now - 1), now - 86_400_000);
  assert.equal(retentionWindow(now), now);
  const first = await createRetentionScheduler(runtime, async () => {
    calls++;
  });
  await first.tick(now);
  await first.tick(now + 60_000);
  assert.equal(calls, 1);
  await first.close();
  const restored = await createRetentionScheduler(runtime, async () => {
    calls++;
  });
  t.after(() => restored.close());
  await restored.tick(now + 80_000);
  assert.equal(calls, 1);
  await restored.tick(now + 2 * 86_400_000);
  assert.equal(calls, 2);
});

test('retention retries a failed batch without overlapping jobs or advancing its checkpoint', async (t) => {
  const runtime = await testRuntime(t);
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const worker = await createRetentionScheduler(runtime, async () => {
    calls++;
    if (calls === 1) {
      await gate;
      throw new Error('temporary failure');
    }
  });
  t.after(() => worker.close());
  const now = Date.UTC(2026, 9, 5, 4);
  const first = worker.tick(now);
  await worker.tick(now);
  finish();
  await assert.rejects(first, /temporary failure/);
  assert.equal(calls, 1);
  assert.equal(
    await runtime.db.get('SELECT * FROM rove_retention_schedule'),
    undefined,
  );
  await worker.tick(now);
  assert.equal(calls, 2);
  await worker.tick(now);
  assert.equal(calls, 2);
});
