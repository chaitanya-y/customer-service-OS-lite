import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseKnowledgeIngestionJob,
} from "../src/contracts/ingestion-schema.js";

const validIngestionJob = {
  ingestionJobId: "ingestion-001",
  idempotencyKey: "acme-refund-policy-2026-08-01",
  status: "QUEUED",

  knowledgeReleaseId: "refund-policy-2026-08-01",
  tenantId: "acme",
  environmentId: "local",

  source: {
    sourceDocumentId: "refund-policy",
    sourceVersion: "2026-08-01",
    title: "Acme Refund Policy",
    contentType: "DOCX",
    classification: "CUSTOMER_SAFE",
    locale: "en-US",
    sourceUri: "s3://cso-knowledge/acme/refund-policy-2026-08-01.docx",
    rawContentSha256: "c".repeat(64),
    effectiveFrom: "2026-08-01T00:00:00Z",
  },

  requestedByPrincipalId: "admin-chaitanya",
  correlationId: "request-7f4c",
  requestedAt: "2026-08-10T17:00:00Z",
} as const;

test("accepts a valid queued ingestion job", () => {
  const job = parseKnowledgeIngestionJob(validIngestionJob);

  assert.equal(job.status, "QUEUED");
  assert.equal(job.source.contentType, "DOCX");
});

test("rejects a completed job without a completion timestamp", () => {
  assert.throws(
    () =>
      parseKnowledgeIngestionJob({
        ...validIngestionJob,
        status: "COMPLETED",
      }),
    /A completed ingestion job needs a completion timestamp/,
  );
});

test("rejects a quarantined job without a failure reason", () => {
  assert.throws(
    () =>
      parseKnowledgeIngestionJob({
        ...validIngestionJob,
        status: "QUARANTINED",
      }),
    /A failed or quarantined job needs a failure reason/,
  );
});

test("rejects a source whose effective period runs backward", () => {
  assert.throws(
    () =>
      parseKnowledgeIngestionJob({
        ...validIngestionJob,
        source: {
          ...validIngestionJob.source,
          effectiveUntil: "2026-07-31T00:00:00Z",
        },
      }),
    /Effective end must be after effective start/,
  );
});