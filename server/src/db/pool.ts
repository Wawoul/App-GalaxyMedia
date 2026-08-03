import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  // Don't let a wedged connect attempt hang a request forever.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

// An idle client killed server-side (a Postgres restart during update.sh, or an
// idle-session timeout) emits 'error' on the pool. With no listener Node treats
// that as unhandled and kills the process - which, under Restart=always, is a
// crash loop rather than the transparent reconnect pg already does for us.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('postgres pool error (idle client dropped, will reconnect):', err.message);
});

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  return pool.query<R>(text, params);
}

/** Run `fn` inside a transaction; rolls back on throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
