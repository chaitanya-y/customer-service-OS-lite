import { z } from "zod";

const sha256Pattern = /^[a-f0-9]{64}$/i;

export const knowledgeReleaseSchema = z
  .object({
    knowledgeReleaseId: z.string().min(1),
    tenantId: z.string().min(1),
    environmentId: z.string().min(1),

    status: z.enum([
      "DRAFT",
      "INDEXING",
      "EVALUATED",
      "PUBLISHED",
      "REVOKED",
    ]),

    sourceManifestSha256: z.string().regex(sha256Pattern),
    embeddingModel: z.string().min(1),
    embeddingDimensions: z.number().int().positive(),
    chunkingStrategyVersion: z.string().min(1),

    openSearchIndexName: z.string().min(1).optional(),
    evaluationDatasetVersion: z.string().min(1).optional(),

    createdAt: z.string().datetime({ offset: true }),
    publishedAt: z.string().datetime({ offset: true }).optional(),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((release, context) => {
    const needsIndex = ["EVALUATED", "PUBLISHED"].includes(release.status);

    if (needsIndex && !release.openSearchIndexName) {
      context.addIssue({
        code: "custom",
        path: ["openSearchIndexName"],
        message: "An evaluated or published release needs an OpenSearch index.",
      });
    }

    if (needsIndex && !release.evaluationDatasetVersion) {
      context.addIssue({
        code: "custom",
        path: ["evaluationDatasetVersion"],
        message: "An evaluated or published release needs an evaluation dataset.",
      });
    }

    if (release.status === "PUBLISHED" && !release.publishedAt) {
      context.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "A published release needs a publication timestamp.",
      });
    }

    if (release.status === "REVOKED" && !release.revokedAt) {
      context.addIssue({
        code: "custom",
        path: ["revokedAt"],
        message: "A revoked release needs a revocation timestamp.",
      });
    }
  });

export type ValidatedKnowledgeRelease = z.infer<
  typeof knowledgeReleaseSchema
>;

export function parseKnowledgeRelease(
  input: unknown,
): ValidatedKnowledgeRelease {
  return knowledgeReleaseSchema.parse(input);
}