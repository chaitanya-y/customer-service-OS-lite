import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseKnowledgeRelease,
} from "../src/contracts/knowledge-release-schema.js";

const validDraftRelease = {
  knowledgeReleaseId: "refund-policy-2026-08-01",
  tenantId: "acme",
  environmentId: "local",
  status: "DRAFT",

  sourceManifestSha256: "a".repeat(64),
  embeddingModel: "text-embedding-3-small",
  embeddingDimensions: 1536,
  chunkingStrategyVersion: "refund-policy-section-v1",

  createdAt: "2026-08-10T15:00:00Z",
} as const;

test("accepts a valid draft knowledge release", () => {
  const release = parseKnowledgeRelease(validDraftRelease);

  assert.equal(release.status, "DRAFT");
  assert.equal(release.knowledgeReleaseId, "refund-policy-2026-08-01");
});

test("rejects a published release without its OpenSearch index", () => {
  assert.throws(
    () =>
      parseKnowledgeRelease({
        ...validDraftRelease,
        status: "PUBLISHED",
        evaluationDatasetVersion: "refund-rag-golden-v1",
        publishedAt: "2026-08-10T16:00:00Z",
      }),
    /An evaluated or published release needs an OpenSearch index/,
  );
});

test("rejects a revoked release without a revocation timestamp", () => {
  assert.throws(
    () =>
      parseKnowledgeRelease({
        ...validDraftRelease,
        status: "REVOKED",
      }),
    /A revoked release needs a revocation timestamp/,
  );
});

test("accepts a fully governed published release", () => {
  const release = parseKnowledgeRelease({
    ...validDraftRelease,
    status: "PUBLISHED",
    openSearchIndexName: "knowledge-acme-refund-policy-2026-08-01",
    evaluationDatasetVersion: "refund-rag-golden-v1",
    publishedAt: "2026-08-10T16:00:00Z",
  });

  assert.equal(release.status, "PUBLISHED");
  assert.equal(
    release.openSearchIndexName,
    "knowledge-acme-refund-policy-2026-08-01",
  );
});