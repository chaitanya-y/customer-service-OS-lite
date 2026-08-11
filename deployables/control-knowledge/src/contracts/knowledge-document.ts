export type KnowledgeDocumentContentType =
  | "PDF"
  | "DOCX"
  | "HTML"
  | "MARKDOWN"
  | "TEXT";

export type KnowledgeDocumentClassification =
  | "CUSTOMER_SAFE"
  | "INTERNAL"
  | "RESTRICTED";

export type KnowledgeDocumentLifecycle =
  | "ACTIVE"
  | "SUPERSEDED"
  | "REVOKED";

export interface KnowledgeDocument {
  knowledgeDocumentId: string;
  sourceDocumentId: string;
  sourceVersion: string;

  tenantId: string;
  environmentId: string;

  title: string;
  contentType: KnowledgeDocumentContentType;
  classification: KnowledgeDocumentClassification;
  lifecycle: KnowledgeDocumentLifecycle;
  locale: string;

  sourceUri: string;
  rawContentSha256: string;
  normalizedText: string;

  effectiveFrom?: string;
  effectiveUntil?: string;
  createdAt: string;
}