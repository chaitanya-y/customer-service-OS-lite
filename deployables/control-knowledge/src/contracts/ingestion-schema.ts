import { z } from "zod";

const sha256Pattern = /^[a-f0-9]{64}$/i;

export const knowledgeIngestionJobSchema = z
  .object({
    ingestionJobId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    status: z.enum([
      "QUEUED",
      "VALIDATING",
      "PROCESSING",
      "COMPLETED",
      "FAILED",
      "QUARANTINED",
    ]),

    knowledgeReleaseId: z.string().min(1),
    tenantId: z.string().min(1),
    environmentId: z.string().min(1),

    source: z.object({
      sourceDocumentId: z.string().min(1),
      sourceVersion: z.string().min(1),

      title: z.string().min(1),
      contentType: z.enum(["PDF", "DOCX", "HTML", "MARKDOWN", "TEXT"]),
      classification: z.enum(["CUSTOMER_SAFE", "INTERNAL", "RESTRICTED"]),
      locale: z.string().min(1),

      sourceUri: z.string().min(1),
      rawContentSha256: z.string().regex(sha256Pattern),

      effectiveFrom: z.string().datetime({ offset: true }).optional(),
      effectiveUntil: z.string().datetime({ offset: true }).optional(),
    }),

    requestedByPrincipalId: z.string().min(1),
    correlationId: z.string().min(1),
    requestedAt: z.string().datetime({ offset: true }),

    failureReason: z.string().min(1).optional(),
    completedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((job, context) => {
    const { effectiveFrom, effectiveUntil } = job.source;

    if (
      effectiveFrom &&
      effectiveUntil &&
      Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)
    ) {
      context.addIssue({
        code: "custom",
        path: ["source", "effectiveUntil"],
        message: "Effective end must be after effective start.",
      });
    }

    if (job.status === "COMPLETED" && !job.completedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A completed ingestion job needs a completion timestamp.",
      });
    }

    if (
      ["FAILED", "QUARANTINED"].includes(job.status) &&
      !job.failureReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "A failed or quarantined job needs a failure reason.",
      });
    }

    if (
      ["QUEUED", "VALIDATING", "PROCESSING", "COMPLETED"].includes(
        job.status,
      ) &&
      job.failureReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "A non-failed job cannot carry a failure reason.",
      });
    }
  });

export type ValidatedKnowledgeIngestionJob = z.infer<
  typeof knowledgeIngestionJobSchema
>;

export function parseKnowledgeIngestionJob(
  input: unknown,
): ValidatedKnowledgeIngestionJob {
  return knowledgeIngestionJobSchema.parse(input);
}