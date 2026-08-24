import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL is required to run migrations');

const pool = new Pool({ connectionString: databaseUrl });
const directory = new URL('../migrations/', import.meta.url);
const client = await pool.connect();
try {
  await client.query('CREATE SCHEMA IF NOT EXISTS platform; CREATE TABLE IF NOT EXISTS platform.schema_migrations (migration_name text PRIMARY KEY, content_sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL)');
  await client.query('SELECT pg_advisory_lock(7102027)');
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const digest = createHash('sha256').update(sql).digest('hex');
    const existing = await client.query<{ content_sha256: string }>('SELECT content_sha256 FROM platform.schema_migrations WHERE migration_name = $1', [name]);
    if (existing.rowCount === 1) {
      if (existing.rows[0]?.content_sha256 !== digest) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO platform.schema_migrations (migration_name, content_sha256, applied_at) VALUES ($1, $2, now())', [name, digest]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
} finally { await client.query('SELECT pg_advisory_unlock(7102027)'); client.release(); await pool.end(); }
