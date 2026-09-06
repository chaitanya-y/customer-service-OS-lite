import { SignJWT } from 'jose';
import { z } from 'zod';

import type { AuthenticatedCustomer } from './customer-identity.js';

export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_ASSERTION_HEADER = 'x-cso-evidence-assertion';
export const EVIDENCE_VERSION_HEADER = 'x-cso-expected-evidence-version';
const mediaType = z.enum(['image/jpeg', 'image/png']);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const attachmentSchema = z.object({
  evidence_id: z.uuid(), display_label: z.string().regex(/^Photo [1-5]$/),
  content_type: mediaType.optional(), byte_size: safeInteger,
  width: z.number().int().min(1).max(65_535).optional(),
  height: z.number().int().min(1).max(65_535).optional(),
  uploaded_at: z.iso.datetime({ offset: true }),
  technical_status: z.enum(['PROCESSING', 'READY', 'REJECTED']),
  rejection_code: z.enum(['FILE_TOO_LARGE', 'UNSUPPORTED_TYPE', 'INVALID_IMAGE', 'IMAGE_LIMIT_EXCEEDED', 'UNSAFE_FILE', 'VALIDATION_UNAVAILABLE']).optional(),
}).strict().superRefine((value, context) => {
  if (value.technical_status === 'READY'
    ? !value.content_type || !value.width || !value.height || value.byte_size < 1
    : value.width !== undefined || value.height !== undefined) {
    context.addIssue({ code: 'custom', message: 'Invalid image readiness metadata' });
  }
  if ((value.technical_status === 'REJECTED') !== (value.rejection_code !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Invalid rejection metadata' });
  }
});

/** Strict allowlist mirrors the canonical customer refund-evidence v1 schema. */
export const refundEvidenceSummarySchema = z.object({
  version: z.literal('v1'), requirement: z.enum(['DAMAGE_PHOTO', 'NONE']),
  evidence_version: safeInteger, assessment: z.enum(['UNREVIEWED', 'ACCEPTED', 'MORE_REQUIRED']),
  can_upload: z.boolean(),
  customer_message_code: z.enum(['PHOTO_UNCLEAR', 'DAMAGED_ITEM_NOT_VISIBLE', 'ORDER_ITEM_NOT_IDENTIFIABLE']).optional(),
  attachments: z.array(attachmentSchema).max(5),
}).strict().superRefine((value, context) => {
  const invalid = (message: string) => context.addIssue({ code: 'custom', message });
  if (new Set(value.attachments.map(item => item.evidence_id)).size !== value.attachments.length) invalid('Duplicate attachment ID');
  if (value.requirement === 'NONE' && (value.can_upload || value.evidence_version !== 0 || value.assessment !== 'UNREVIEWED' || value.attachments.length || value.customer_message_code)) invalid('Invalid absent requirement');
  if (value.evidence_version === 0 && (value.assessment !== 'UNREVIEWED' || value.attachments.length)) invalid('Invalid initial revision');
  if (value.assessment === 'ACCEPTED' && (value.requirement !== 'DAMAGE_PHOTO' || value.evidence_version < 1 || value.can_upload || !value.attachments.length || value.attachments.some(item => item.technical_status !== 'READY'))) invalid('Invalid accepted set');
  if ((value.assessment === 'MORE_REQUIRED') !== (value.customer_message_code !== undefined) || (value.assessment === 'MORE_REQUIRED' && value.evidence_version < 1)) invalid('Invalid customer review message');
});

export type RefundEvidenceSummary = z.infer<typeof refundEvidenceSummarySchema>;
export type EvidenceRequestContext = Readonly<{
  workflowId: string; identity: AuthenticatedCustomer; requestId: string; traceId: string;
}>;
type EvidencePurpose = 'refund_evidence_read' | 'refund_evidence_upload' | 'refund_evidence_content';
export type SignEvidenceAssertion = (input: EvidenceRequestContext & { purpose: EvidencePurpose }) => Promise<string>;
export type RefundEvidenceClient = Readonly<{
  getSummary(input: EvidenceRequestContext): Promise<RefundEvidenceSummary | undefined>;
  upload(input: EvidenceRequestContext & { body: Buffer; contentType: 'image/jpeg' | 'image/png'; idempotencyKey: string; expectedVersion: number }): Promise<RefundEvidenceSummary>;
  getContent(input: EvidenceRequestContext & { evidenceId: string }): Promise<{ body: Buffer; contentType: 'image/jpeg' | 'image/png' }>;
}>;

export class RefundEvidenceError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super('Photo evidence request failed');
    this.name = 'RefundEvidenceError';
  }
}

const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export function createEvidenceAssertionSigner({ secret, issuer = 'customer-service-os-edge', now = () => new Date() }: {
  secret: string; issuer?: string; now?: () => Date;
}): SignEvidenceAssertion {
  if (Buffer.byteLength(secret) < 32) throw new Error('Evidence assertion secret must contain at least 32 bytes');
  const key = new TextEncoder().encode(secret);
  return async input => {
    const identity = z.object({ principalId: opaqueId, customerId: opaqueId, tenantId: opaqueId, environmentId: opaqueId }).strict().parse(input.identity);
    if (identity.principalId !== identity.customerId) throw new Error('Evidence self-service identity mismatch');
    const workflowId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).parse(input.workflowId);
    const purpose = z.enum(['refund_evidence_read', 'refund_evidence_upload', 'refund_evidence_content']).parse(input.purpose);
    const issuedAt = Math.floor(now().getTime() / 1000);
    return new SignJWT({
      accessVersion: '1', workflow: { workflowId },
      tenant: { tenantId: identity.tenantId, environmentId: identity.environmentId },
      subject: { customerId: identity.customerId }, purpose,
      request: { requestId: opaqueId.parse(input.requestId), traceId: opaqueId.parse(input.traceId) },
    }).setProtectedHeader({ alg: 'HS256', typ: 'cso-evidence+jwt' })
      .setIssuer(issuer).setAudience('human-operations-evidence')
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 60).sign(key);
  };
}

const errorStatuses: Readonly<Record<string, number>> = {
  evidence_unauthorized: 503, evidence_not_found: 404,
  stale_evidence_version: 409, evidence_frozen: 409, evidence_limit_exceeded: 409, idempotency_conflict: 409,
  invalid_evidence: 400, evidence_too_large: 413, unsupported_evidence_type: 415, evidence_unavailable: 503,
};

async function readBounded(response: Response, maximumBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  let size = 0;
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumBytes) throw new RefundEvidenceError(503, 'evidence_unavailable');
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function createRefundEvidenceClient({ baseUrl, signAssertion, fetchImpl = fetch, timeoutMilliseconds = 30_000 }: {
  baseUrl: string; signAssertion: SignEvidenceAssertion; fetchImpl?: typeof fetch; timeoutMilliseconds?: number;
}): RefundEvidenceClient {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid evidence service URL');
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) throw new Error('Invalid evidence timeout');
  async function request(input: EvidenceRequestContext, purpose: EvidencePurpose, suffix = '', init: RequestInit = {}) {
    const assertion = await signAssertion({ ...input, purpose });
    try {
      const response = await fetchImpl(new URL(`/internal/v1/customer-refund-evidence/${encodeURIComponent(input.workflowId)}${suffix}`, base), {
        ...init, headers: { ...init.headers, [EVIDENCE_ASSERTION_HEADER]: assertion },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMilliseconds),
      });
      if (!response.ok) {
        const text = (await readBounded(response, 8192)).toString();
        let code = 'evidence_unavailable';
        try { const error = JSON.parse(text)?.error?.code; if (Object.hasOwn(errorStatuses, error)) code = error; } catch { /* Never expose upstream content. */ }
        // A bad internal assertion is a service error, not a customer login failure.
        throw new RefundEvidenceError(errorStatuses[code] ?? 503, code === 'evidence_unauthorized' ? 'evidence_unavailable' : code);
      }
      return response;
    } catch (error) {
      if (error instanceof RefundEvidenceError) throw error;
      throw new RefundEvidenceError(503, 'evidence_unavailable');
    }
  }
  async function summary(response: Response) {
    try {
      const body = JSON.parse((await readBounded(response, 32_768)).toString());
      return z.object({ evidence: refundEvidenceSummarySchema }).strict().parse(body).evidence;
    } catch { throw new RefundEvidenceError(503, 'evidence_unavailable'); }
  }
  return {
    async getSummary(input) {
      try { return await summary(await request(input, 'refund_evidence_read')); }
      catch (error) { if (error instanceof RefundEvidenceError && error.code === 'evidence_not_found') return undefined; throw error; }
    },
    async upload(input) {
      if (!Buffer.isBuffer(input.body) || input.body.length === 0 || input.body.length > MAX_EVIDENCE_BYTES) throw new RefundEvidenceError(413, 'evidence_too_large');
      return summary(await request(input, 'refund_evidence_upload', '', {
        method: 'POST', headers: { 'content-type': input.contentType, 'idempotency-key': input.idempotencyKey, [EVIDENCE_VERSION_HEADER]: String(input.expectedVersion) },
        body: new Uint8Array(input.body),
      }));
    },
    async getContent(input) {
      const response = await request(input, 'refund_evidence_content', `/${encodeURIComponent(input.evidenceId)}/content`);
      const contentType = mediaType.safeParse(response.headers.get('content-type'));
      if (!contentType.success) { await response.body?.cancel(); throw new RefundEvidenceError(503, 'evidence_unavailable'); }
      const body = await readBounded(response, MAX_EVIDENCE_BYTES);
      const signatureValid = contentType.data === 'image/png'
        ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : body.length >= 3 && body[0] === 255 && body[1] === 216 && body[2] === 255;
      if (!signatureValid) throw new RefundEvidenceError(503, 'evidence_unavailable');
      return { body, contentType: contentType.data };
    },
  };
}
