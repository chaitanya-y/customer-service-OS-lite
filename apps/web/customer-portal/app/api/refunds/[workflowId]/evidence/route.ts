import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalCustomerRequest, proxyEdgeEvidence } from "../../../../../lib/refund-proxy";
import { EvidenceUploadError, evidenceUploadHeaders, readEvidenceUpload } from "../../../../../lib/evidence-upload";

export async function POST(request: NextRequest, context: { params: Promise<{ workflowId: string }> }) {
  const authorization = authorizeLocalCustomerRequest(request, { requireSameOrigin: true });
  if (authorization instanceof NextResponse) return authorization;
  try {
    const { contentType, idempotencyKey, version } = evidenceUploadHeaders(request.headers);
    const body = await readEvidenceUpload(request.body);
    const { workflowId } = await context.params;
    return proxyEdgeEvidence({ authorization, body,
      path: `/v1/refunds/${encodeURIComponent(workflowId)}/evidence`,
      headers: { "content-type": contentType, "idempotency-key": idempotencyKey, "x-cso-expected-evidence-version": version },
    });
  } catch (error) {
    return NextResponse.json({ error: { code: "invalid_evidence", message: error instanceof EvidenceUploadError ? error.message : "The upload could not be read. Please try again." } },
      { status: error instanceof EvidenceUploadError ? error.status : 400, headers: { "cache-control": "no-store" } });
  }
}
