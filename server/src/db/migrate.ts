import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import argon2 from 'argon2';
import { pool, withTransaction } from './pool.js';
import { config } from '../config.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    // eslint-disable-next-line no-console
    console.log(`applied ${file}`);
  }

  await bootstrapAdmin();
}

/** Create the first MSP admin from env if the users table is empty. */
async function bootstrapAdmin(): Promise<void> {
  const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM users');
  if (Number(rows[0]?.count ?? 0) > 0) return;
  const email = config.BOOTSTRAP_ADMIN_EMAIL;
  const password = config.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.warn('No users exist and BOOTSTRAP_ADMIN_EMAIL/PASSWORD not set - no admin created.');
    return;
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, level, role)
     VALUES ($1, $2, 'MSP Admin', 'msp', 'admin')`,
    [email, hash],
  );
  // eslint-disable-next-line no-console
  console.log(`bootstrap admin created: ${email} (2FA enrollment required at first login)`);
}

// Run directly: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
