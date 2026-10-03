import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { createClient } from 'redis';
import type { Config } from '../src/config.js';
import { closeRuntime, openRuntime } from '../src/runtime.js';

async function allocate() {
  const id = randomUUID().replaceAll('-', '');
  const name = `rove_test_${id}`;
  const databaseURL = new URL(
    process.env.TEST_DATABASE_URL ||
      'postgres://rove:rove@127.0.0.1:54329/postgres',
  );
  const admin = new Pool({ connectionString: databaseURL.href });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const adminURL = databaseURL.href;
  databaseURL.pathname = `/${name}`;
  const config: Config = {
    baseURL: 'http://localhost:3000',
    authSecret: 'a'.repeat(64),
    setupSecret: 's'.repeat(64),
    databaseURL: databaseURL.href,
    redisURL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6389',
    redisPrefix: `test:${id}`,
  };
  const cleanup = async () => {
    const cleanup = new Pool({ connectionString: adminURL });
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await cleanup.end();
    }
    const redis = createClient({
      url: config.redisURL,
      socket: { reconnectStrategy: false },
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      for await (const keys of redis.scanIterator({
        MATCH: `${config.redisPrefix}:*`,
        COUNT: 100,
      })) {
        if (keys.length) await redis.del(keys);
      }
    } finally {
      if (redis.isOpen) redis.destroy();
    }
  };
  return { config, cleanup };
}

export async function testConfig(t: TestContext): Promise<Config> {
  const { config, cleanup } = await allocate();
  t.after(cleanup);
  return config;
}

export async function testRuntime(t: TestContext) {
  const { config, cleanup } = await allocate();
  try {
    const runtime = await openRuntime(config);
    t.after(async () => {
      try {
        await closeRuntime(runtime);
      } finally {
        await cleanup();
      }
    });
    return runtime;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
