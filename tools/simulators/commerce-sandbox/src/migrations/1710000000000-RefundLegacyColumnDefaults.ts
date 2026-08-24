type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/**
 * Vendure no longer populates the legacy refund component columns for the
 * refundOrder mutation, but older SQLite schemas still mark them NOT NULL.
 * Keep those deprecated components representable as zero for local refunds.
 */
export class RefundLegacyColumnDefaults1710000000000 {
  name = 'RefundLegacyColumnDefaults1710000000000';

  async up(queryRunner: MigrationQueryRunner): Promise<void> {
    // The follow-up migration performs the SQLite table rebuild required to
    // add defaults. This migration only normalizes any legacy NULL values.
    await queryRunner.query(
      'UPDATE "refund" SET "items" = COALESCE("items", 0), "shipping" = COALESCE("shipping", 0), "adjustment" = COALESCE("adjustment", 0)',
    );
  }

  async down(_queryRunner: MigrationQueryRunner): Promise<void> {
    // Defaults are removed by the explicit follow-up migration if it is
    // reverted; legacy NULL values are intentionally not recreated.
  }
}
