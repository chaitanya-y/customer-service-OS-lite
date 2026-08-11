import type { KnowledgeDocumentClassification } from "./knowledge-document.js";

export interface KnowledgeChunk {
  chunkId: string;
  chunkOrdinal: number;
  parentChunkId?: string;

  knowledgeReleaseId: string;
  tenantId: string;
  environmentId: string;

  knowledgeDocumentId: string;
  sourceDocumentId: string;
  sourceVersion: string;

  title: string;
  sectionPath: string[];
  pageStart?: number;
  pageEnd?: number;

  content: string;
  contentSha256: string;
  chunkingStrategyVersion: string;

  locale: string;
  classification: KnowledgeDocumentClassification;
  effectiveFrom?: string;
  effectiveUntil?: string;

  sourceUri: string;
}