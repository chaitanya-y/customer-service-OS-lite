import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run migrations');
}

const pool = new Pool({ connectionString: databaseUrl });
const migrationDirectory = new URL('../migrations/', import.meta.url);
const client = await pool.connect();

try {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.schema_migrations (
      migration_name text PRIMARY KEY,
      content_sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);
  await client.query('SELECT pg_advisory_lock(7102026)');

  for (const migrationName of (await readdir(migrationDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const migrationSql = await readFile(
      new URL(migrationName, migrationDirectory),
      'utf8',
    );
    const contentSha256 = createHash('sha256')
      .update(migrationSql)
      .digest('hex');
    const existing = await client.query<{ content_sha256: string }>(
      `
        SELECT content_sha256
        FROM platform.schema_migrations
        WHERE migration_name = $1
      `,
      [migrationName],
    );

    if (existing.rowCount === 1) {
      if (existing.rows[0]?.content_sha256 !== contentSha256) {
        throw new Error(`Applied migration changed: ${migrationName}`);
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(migrationSql);
      await client.query(
        `
          INSERT INTO platform.schema_migrations (
            migration_name,
            content_sha256,
            applied_at
          )
          VALUES ($1, $2, now())
        `,
        [migrationName, contentSha256],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(7102026)');
  client.release();
  await pool.end();
}
