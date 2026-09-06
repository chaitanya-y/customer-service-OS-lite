import { MAX_EVIDENCE_UPLOAD_BYTES } from "@cso/ui/refund-evidence-model";

export class EvidenceUploadError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function evidenceUploadHeaders(headers: Headers) {
  const contentType = headers.get("content-type");
  if (contentType !== "image/jpeg" && contentType !== "image/png") {
    throw new EvidenceUploadError(415, "Choose a JPEG or PNG photo.");
  }
  const idempotencyKey = headers.get("idempotency-key");
  const version = headers.get("x-cso-expected-evidence-version");
  if (!idempotencyKey?.trim() || idempotencyKey.length > 200 || !version ||
    !/^(0|[1-9][0-9]*)$/.test(version) || !Number.isSafeInteger(Number(version))) {
    throw new EvidenceUploadError(400, "The upload request is invalid. Refresh and try again.");
  }
  const length = headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length) > MAX_EVIDENCE_UPLOAD_BYTES)) {
    throw new EvidenceUploadError(413, "Choose a photo smaller than 10 MB.");
  }
  return { contentType, idempotencyKey, version };
}

/** Bound reads even when Content-Length is absent or dishonest. */
export async function readEvidenceUpload(body: ReadableStream<Uint8Array> | null): Promise<ArrayBuffer> {
  if (!body) throw new EvidenceUploadError(400, "Choose a photo to upload.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVIDENCE_UPLOAD_BYTES) {
        await reader.cancel();
        throw new EvidenceUploadError(413, "Choose a photo smaller than 10 MB.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new EvidenceUploadError(400, "Choose a non-empty photo.");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
