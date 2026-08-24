import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseKnowledgeChunk,
} from "../src/contracts/knowledge-chunk-schema.js";

const validChunk = {
  chunkId: "refund-policy-2026-08-01-damaged-items-001",
  chunkOrdinal: 12,

  knowledgeReleaseId: "refund-policy-2026-08-01",
  tenantId: "acme",
  environmentId: "local",

  knowledgeDocumentId: "refund-policy-2026-08-01",
  sourceDocumentId: "refund-policy",
  sourceVersion: "2026-08-01",

  title: "Acme Refund Policy",
  sectionPath: ["Refund eligibility", "Damaged items"],
  pageStart: 3,
  pageEnd: 3,

  content:
    "Damaged items may be refunded within 30 days of delivery. Photo evidence is required.",
  contentSha256: "b".repeat(64),
  chunkingStrategyVersion: "refund-policy-section-v1",

  locale: "en-US",
  classification: "CUSTOMER_SAFE",

  sourceUri: "s3://cso-knowledge/acme/refund-policy-2026-08-01.pdf",
} as const;

test("accepts a citation-ready knowledge chunk", () => {
  const chunk = parseKnowledgeChunk(validChunk);

  assert.equal(chunk.chunkOrdinal, 12);
  assert.deepEqual(chunk.sectionPath, [
    "Refund eligibility",
    "Damaged items",
  ]);
});

test("rejects a citation with an invalid page range", () => {
  assert.throws(
    () =>
      parseKnowledgeChunk({
        ...validChunk,
        pageStart: 4,
        pageEnd: 3,
      }),
    /Page end cannot be before page start/,
  );
});

test("rejects a chunk with empty content", () => {
  assert.throws(
    () =>
      parseKnowledgeChunk({
        ...validChunk,
        content: "   ",
      }),
    /Chunk content is required/,
  );
});

test("rejects a chunk that points to itself as parent", () => {
  assert.throws(
    () =>
      parseKnowledgeChunk({
        ...validChunk,
        parentChunkId: validChunk.chunkId,
      }),
    /A chunk cannot be its own parent/,
  );
});