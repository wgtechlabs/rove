import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from '../src/app.js';
import { createDatabase } from '../src/database.js';
import { testConfig, testRuntime } from './storage.js';

test('PostgreSQL enables vector and rolls back awaited transactions on one connection', async (t) => {
  const { db } = await testRuntime(t);
  assert.equal(
    (await db.get("SELECT '[1,2,3]'::vector::text AS value"))?.value,
    '[1,2,3]',
  );
  await db.migrate('CREATE TABLE transaction_probe (id INTEGER PRIMARY KEY)');
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO transaction_probe VALUES ($1)', [1]);
      await tx.run('INSERT INTO transaction_probe VALUES ($1)', [1]);
    }),
    /duplicate key/,
  );
  assert.deepEqual(await db.all('SELECT * FROM transaction_probe'), []);
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO transaction_probe VALUES ($1)', [2]);
    assert.equal(
      (await tx.get('SELECT count(*) AS count FROM transaction_probe'))?.count,
      1,
    );
  });
  assert.equal((await db.get('SELECT id FROM transaction_probe'))?.id, 2);
});

test('a second application cannot recover work owned by the active core', async (t) => {
  const config = await testConfig(t);
  const app = await createApplication(config);
  const db = await createDatabase(config.databaseURL);
  try {
    const interrupted = JSON.stringify({
      id: 'active-run',
      conversation: 'thread',
      scope: 'web:thread',
      prompt: 'action',
      history: [],
      status: 'executing',
      steps: 1,
      direct: true,
    });
    await db.run(
      'INSERT INTO rove_run(id,conversation,scope,data) VALUES($1,$2,$3,$4)',
      ['active-run', 'thread', 'web:thread', interrupted],
    );
    await assert.rejects(createApplication(config), /Another Rove core owns/);
    assert.equal(
      (await app.fetch(new Request(`${config.baseURL}/health`))).status,
      200,
    );
    assert.equal(
      (await db.get('SELECT data FROM rove_run WHERE id=$1', ['active-run']))
        ?.data,
      interrupted,
    );
  } finally {
    await db.close();
    await app.close();
  }
  const restarted = await createApplication(config);
  const check = await createDatabase(config.databaseURL);
  try {
    assert.equal(
      (await restarted.fetch(new Request(`${config.baseURL}/health`))).status,
      200,
    );
    const recovered = JSON.parse(
      String(
        (
          await check.get('SELECT data FROM rove_run WHERE id=$1', [
            'active-run',
          ])
        )?.data,
      ),
    );
    assert.equal(recovered.status, 'done');
    assert.match(recovered.answer, /outcome unknown/);
  } finally {
    await check.close();
    await restarted.close();
  }
});

test('startup failure releases Redis ownership for a repaired configuration', async (t) => {
  const config = await testConfig(t);
  await assert.rejects(
    createApplication({
      ...config,
      databaseURL: 'postgres://rove:rove@127.0.0.1:1/rove',
    }),
  );
  const app = await createApplication(config);
  try {
    assert.equal(
      (await app.fetch(new Request(`${config.baseURL}/health`))).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test('lost ownership rejects mutations and rolls back writes made before an awaited gap', async (t) => {
  const runtime = await testRuntime(t);
  const observer = await createDatabase(runtime.databaseURL);
  try {
    await runtime.db.migrate(
      'CREATE TABLE ownership_write (id INTEGER PRIMARY KEY)',
    );
    await assert.rejects(
      runtime.db.transaction(async (tx) => {
        await tx.run('INSERT INTO ownership_write VALUES (1)');
        await runtime.state.close();
      }),
      /ownership is unavailable/,
    );
    await assert.rejects(
      runtime.db.run('INSERT INTO ownership_write VALUES (2)'),
      /ownership is unavailable/,
    );
    assert.deepEqual(await observer.all('SELECT * FROM ownership_write'), []);
  } finally {
    await observer.close();
  }
});
