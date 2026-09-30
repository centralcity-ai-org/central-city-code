import { Pool } from 'pg';

/** Small common surface implemented by both PGlite and managed PostgreSQL. */
export interface Transaction {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
export interface Database extends Transaction {
  transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgresDatabase(pool: Pool): Database {
  // Idle network errors must not become uncaught exceptions or leak connection details.
  pool.on('error', () => {});
  const query: Transaction['query'] = async (sql, params) => {
    const result = await pool.query(sql, params);
    return { rows: result.rows };
  };
  const transaction: Database['transaction'] = async (action) => {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      const result = await action({
        query: async (sql, params) => ({ rows: (await client.query(sql, params)).rows }),
        exec: (sql) => client.query(sql),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  };
  return {
    query,
    transaction,
    // Serialize schema initialization across independent function instances.
    exec: (sql) =>
      transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(1128485465)');
        return tx.exec(sql);
      }),
    close: () => pool.end(),
  };
}

export async function openPostgres(connectionString: string): Promise<Database> {
  const url = new URL(connectionString);
  // pg connection-string SSL switches can override the explicit TLS object.
  for (const key of [...url.searchParams.keys()])
    if (key.toLowerCase().startsWith('ssl') || key === 'uselibpqcompat')
      url.searchParams.delete(key);
  const db = postgresDatabase(
    new Pool({
      connectionString: url.toString(),
      ssl: { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 10_000,
      allowExitOnIdle: true,
    }),
  );
  try {
    await db.query('SELECT 1');
    return db;
  } catch {
    await db.close();
    throw new Error('Hosted database connection failed.');
  }
}
