type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/**
 * SQLite cannot alter a column default in place. Rebuild the legacy refund
 * table so refundOrder can omit deprecated component values safely.
 */
export class EnsureRefundLegacyColumnDefaults1710000000001 {
  name = 'EnsureRefundLegacyColumnDefaults1710000000001';

  async up(queryRunner: MigrationQueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = OFF');
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
        "items" integer NOT NULL DEFAULT 0,
        "shipping" integer NOT NULL DEFAULT 0,
        "adjustment" integer NOT NULL DEFAULT 0,
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
    await queryRunner.query('PRAGMA foreign_keys = ON');
  }

  async down(queryRunner: MigrationQueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys = OFF');
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
        "items" integer NOT NULL,
        "shipping" integer NOT NULL,
        "adjustment" integer NOT NULL,
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
    await queryRunner.query('PRAGMA foreign_keys = ON');
  }
}
