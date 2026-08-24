import type {
  KnowledgeDocumentClassification,
  KnowledgeDocumentContentType,
} from "./knowledge-document.js";

export type IngestionJobStatus =
  | "QUEUED"
  | "VALIDATING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "QUARANTINED";

export interface KnowledgeSourceRevision {
  sourceDocumentId: string;
  sourceVersion: string;

  title: string;
  contentType: KnowledgeDocumentContentType;
  classification: KnowledgeDocumentClassification;
  locale: string;

  sourceUri: string;
  rawContentSha256: string;

  effectiveFrom?: string;
  effectiveUntil?: string;
}

export interface KnowledgeIngestionJob {
  ingestionJobId: string;
  idempotencyKey: string;
  status: IngestionJobStatus;

  knowledgeReleaseId: string;
  tenantId: string;
  environmentId: string;

  source: KnowledgeSourceRevision;

  requestedByPrincipalId: string;
  correlationId: string;
  requestedAt: string;

  failureReason?: string;
  completedAt?: string;
}