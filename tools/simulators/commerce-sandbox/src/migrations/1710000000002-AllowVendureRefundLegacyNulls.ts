type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/**
 * The running Vendure schema writes null for deprecated refund components.
 * Keep those legacy fields nullable at the storage boundary and normalize
 * them to zero immediately so API reads remain deterministic.
 */
export class AllowVendureRefundLegacyNulls1710000000002 {
  name = 'AllowVendureRefundLegacyNulls1710000000002';

  async up(queryRunner: MigrationQueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = OFF');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_1c6932a756108788a361e7d440"');
    await queryRunner.query('ALTER TABLE "refund" RENAME TO "refund_previous"');
    await queryRunner.query(`
      CREATE TABLE "refund" (
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
        "total" integer NOT NULL,
        CONSTRAINT "FK_1c6932a756108788a361e7d4404"
          FOREIGN KEY ("paymentId") REFERENCES "payment" ("id")
          ON DELETE NO ACTION ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      INSERT INTO "refund" (
        "createdAt", "updatedAt", "method", "reason", "state",
        "transactionId", "metadata", "id", "paymentId", "items",
        "shipping", "adjustment", "total"
      )
      SELECT
        "createdAt", "updatedAt", "method", "reason", "state",
        "transactionId", "metadata", "id", "paymentId", "items",
        "shipping", "adjustment", "total"
      FROM "refund_previous"
    `);
    await queryRunner.query('DROP TABLE "refund_previous"');
    await queryRunner.query(
      'CREATE INDEX "IDX_1c6932a756108788a361e7d440" ON "refund" ("paymentId")',
    );
    await queryRunner.query(`
      CREATE TRIGGER "TRG_refund_normalize_legacy_components"
      AFTER INSERT ON "refund"
      WHEN NEW."items" IS NULL OR NEW."shipping" IS NULL OR NEW."adjustment" IS NULL
      BEGIN
        UPDATE "refund"
        SET "items" = COALESCE("items", 0),
            "shipping" = COALESCE("shipping", 0),
            "adjustment" = COALESCE("adjustment", 0)
        WHERE "id" = NEW."id";
      END
    `);
    await queryRunner.query('PRAGMA foreign_keys = ON');
  }

  async down(_queryRunner: MigrationQueryRunner): Promise<void> {
    // The legacy columns are intentionally kept nullable for compatibility
    // with the Vendure runtime used by this local simulator.
  }
}
