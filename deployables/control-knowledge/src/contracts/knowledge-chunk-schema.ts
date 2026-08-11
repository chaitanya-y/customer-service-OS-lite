import { z } from "zod";

const sha256Pattern = /^[a-f0-9]{64}$/i;

export const knowledgeChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    chunkOrdinal: z.number().int().nonnegative(),
    parentChunkId: z.string().min(1).optional(),

    knowledgeReleaseId: z.string().min(1),
    tenantId: z.string().min(1),
    environmentId: z.string().min(1),

    knowledgeDocumentId: z.string().min(1),
    sourceDocumentId: z.string().min(1),
    sourceVersion: z.string().min(1),

    title: z.string().min(1),
    sectionPath: z.array(z.string().min(1)).min(1),
    pageStart: z.number().int().positive().optional(),
    pageEnd: z.number().int().positive().optional(),

    content: z
      .string()
      .refine((value) => value.trim().length > 0, "Chunk content is required."),
    contentSha256: z.string().regex(sha256Pattern),
    chunkingStrategyVersion: z.string().min(1),

    locale: z.string().min(1),
    classification: z.enum(["CUSTOMER_SAFE", "INTERNAL", "RESTRICTED"]),
    effectiveFrom: z.string().datetime({ offset: true }).optional(),
    effectiveUntil: z.string().datetime({ offset: true }).optional(),

    sourceUri: z.string().min(1),
  })
  .strict()
  .superRefine((chunk, context) => {
    const hasOnlyOnePageBoundary =
      (chunk.pageStart === undefined) !== (chunk.pageEnd === undefined);

    if (hasOnlyOnePageBoundary) {
      context.addIssue({
        code: "custom",
        path: ["pageStart"],
        message: "Page start and page end must be supplied together.",
      });
    }

    if (
      chunk.pageStart !== undefined &&
      chunk.pageEnd !== undefined &&
      chunk.pageEnd < chunk.pageStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["pageEnd"],
        message: "Page end cannot be before page start.",
      });
    }

    if (chunk.parentChunkId === chunk.chunkId) {
      context.addIssue({
        code: "custom",
        path: ["parentChunkId"],
        message: "A chunk cannot be its own parent.",
      });
    }
  });

export type ValidatedKnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export function parseKnowledgeChunk(input: unknown): ValidatedKnowledgeChunk {
  return knowledgeChunkSchema.parse(input);
}