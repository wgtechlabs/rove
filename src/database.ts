import { Pool, type PoolClient, types } from 'pg';

// Custom tables use BIGINT for epoch milliseconds and identity sequences.
types.setTypeParser(20, (value: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error('Database integer exceeds the supported range.');
  return number;
});

export interface Sql {
  get<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
  all<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
  exec(sql: string): Promise<void>;
}

function queries(
  connection: Pool | PoolClient,
  beforeWrite?: () => Promise<void>,
): Sql {
  return {
    async get<T>(sql: string, params?: unknown[]) {
      return (await connection.query(sql, params)).rows[0] as T | undefined;
    },
    async all<T>(sql: string, params?: unknown[]) {
      return (await connection.query(sql, params)).rows as T[];
    },
    async run(sql, params) {
      await beforeWrite?.();
      return (await connection.query(sql, params)).rowCount ?? 0;
    },
    async exec(sql) {
      await beforeWrite?.();
      await connection.query(sql);
    },
  };
}

export type Database = Sql & {
  pool: Pool;
  migrate(sql: string): Promise<void>;
  transaction<T>(action: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export async function createDatabase(
  databaseURL: string,
  beforeWrite?: () => Promise<void>,
): Promise<Database> {
  const pool = new Pool({
    connectionString: databaseURL,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 20000,
    idle_in_transaction_session_timeout: 15000,
  });
  pool.on('error', () => console.error('PostgreSQL connection failed.'));
  async function transaction<T>(action: (tx: Sql) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await action(queries(client, beforeWrite));
      await beforeWrite?.();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken);
    }
  }
  const db: Database = {
    ...queries(pool, beforeWrite),
    pool,
    transaction,
    async migrate(sql) {
      await transaction(async (tx) => {
        await tx.exec('SELECT pg_advisory_xact_lock(728683001)');
        await tx.exec(sql);
      });
    },
    close: () => pool.end(),
  };
  try {
    await db.migrate('CREATE EXTENSION IF NOT EXISTS vector');
    await db.exec("SELECT '[1,2,3]'::vector");
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
