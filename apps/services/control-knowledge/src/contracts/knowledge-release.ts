export type KnowledgeReleaseStatus =
  | "DRAFT"
  | "INDEXING"
  | "EVALUATED"
  | "PUBLISHED"
  | "REVOKED";

export interface KnowledgeRelease {
  knowledgeReleaseId: string;
  tenantId: string;
  environmentId: string;
  status: KnowledgeReleaseStatus;

  sourceManifestSha256: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkingStrategyVersion: string;

  openSearchIndexName?: string;
  evaluationDatasetVersion?: string;

  createdAt: string;
  publishedAt?: string;
  revokedAt?: string;
}