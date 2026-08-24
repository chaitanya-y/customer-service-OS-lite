type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/**
 * The earlier SQLite table rebuild rewrote dependent foreign keys to the
 * temporary table name `refund_previous`. Keep that parent name as a small
 * compatibility mirror instead of rebuilding unrelated order tables.
 */
export class RepairRefundForeignKeyAlias1710000000003 {
  name = 'RepairRefundForeignKeyAlias1710000000003';

  async up(queryRunner: MigrationQueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "refund_previous" (
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
        "method" varchar NOT NULL,
        "reason" varchar,
        "state" varchar NOT NULL,
        "transactionId" varchar,
        "metadata" text NOT NULL,
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "paymentId" integer NOT NULL,
        "items" integer DEFAULT 0,
        "shipping" integer DEFAULT 0,
        "adjustment" integer DEFAULT 0,
        "total" integer NOT NULL
      )
    `);
    await queryRunner.query(`
      INSERT OR REPLACE INTO "refund_previous" (
        "createdAt", "updatedAt", "method", "reason", "state",
        "transactionId", "metadata", "id", "paymentId", "items",
        "shipping", "adjustment", "total"
      )
      SELECT
        "createdAt", "updatedAt", "method", "reason", "state",
        "transactionId", "metadata", "id", "paymentId", "items",
        "shipping", "adjustment", "total"
      FROM "refund"
    `);
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "TRG_refund_sync_previous_insert"
      AFTER INSERT ON "refund"
      BEGIN
        INSERT OR REPLACE INTO "refund_previous"
        SELECT NEW."createdAt", NEW."updatedAt", NEW."method", NEW."reason",
          NEW."state", NEW."transactionId", NEW."metadata", NEW."id",
          NEW."paymentId", NEW."items", NEW."shipping", NEW."adjustment", NEW."total";
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "TRG_refund_sync_previous_update"
      AFTER UPDATE ON "refund"
      BEGIN
        INSERT OR REPLACE INTO "refund_previous"
        SELECT NEW."createdAt", NEW."updatedAt", NEW."method", NEW."reason",
          NEW."state", NEW."transactionId", NEW."metadata", NEW."id",
          NEW."paymentId", NEW."items", NEW."shipping", NEW."adjustment", NEW."total";
      END
    `);
    await queryRunner.query(`
      CREATE TRIGGER IF NOT EXISTS "TRG_refund_sync_previous_delete"
      AFTER DELETE ON "refund"
      BEGIN
        DELETE FROM "refund_previous" WHERE "id" = OLD."id";
      END
    `);
  }

  async down(queryRunner: MigrationQueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER IF EXISTS "TRG_refund_sync_previous_insert"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "TRG_refund_sync_previous_update"');
    await queryRunner.query('DROP TRIGGER IF EXISTS "TRG_refund_sync_previous_delete"');
    await queryRunner.query('DROP TABLE IF EXISTS "refund_previous"');
  }
}
