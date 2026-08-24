import type { KnowledgeDocumentClassification } from "./knowledge-document.js";

export interface RetrievalRequest {
  tenantId: string;
  environmentId: string;
  knowledgeReleaseId: string;

  query: string;
  locale?: string;
  allowedClassifications: KnowledgeDocumentClassification[];

  maxResults: number;
}

export interface RetrievedEvidence {
  chunkId: string;
  knowledgeDocumentId: string;

  title: string;
  sectionPath: string[];
  pageNumber?: number;

  content: string;
  score: number;

  sourceUri: string;
  sourceVersion: string;
}

export interface RetrievalResponse {
  knowledgeReleaseId: string;
  evidence: RetrievedEvidence[];
  insufficientEvidence: boolean;
  retrievedAt: string;
}