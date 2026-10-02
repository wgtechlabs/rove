import type { Config } from './config.js';
import { createDatabase, type Database } from './database.js';
import { createRuntimeState, type RuntimeState } from './runtime-state.js';

export type RuntimeConfig = Config & { db: Database; state: RuntimeState };

export async function openRuntime(config: Config): Promise<RuntimeConfig> {
  // Acquire ownership before any store can recover interrupted work.
  const state = await createRuntimeState(config);
  try {
    const db = await createDatabase(config.databaseURL, state.assertOwned);
    try {
      await state.assertOwned();
    } catch (error) {
      await db.close();
      throw error;
    }
    return { ...config, db, state };
  } catch (error) {
    await state.close();
    throw error;
  }
}

export async function closeRuntime(config: RuntimeConfig) {
  try {
    await config.db.close();
  } finally {
    await config.state.close();
  }
}
