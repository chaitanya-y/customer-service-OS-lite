import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalCustomerRequest, proxyEdgeEvidence } from "../../../../../../../lib/refund-proxy";

export async function GET(request: NextRequest, context: { params: Promise<{ workflowId: string; evidenceId: string }> }) {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return authorization;
  const { workflowId, evidenceId } = await context.params;
  return proxyEdgeEvidence({ authorization,
    path: `/v1/refunds/${encodeURIComponent(workflowId)}/evidence/${encodeURIComponent(evidenceId)}/content`,
  });
}
