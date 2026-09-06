import { NextRequest, NextResponse } from "next/server";
import { authorizeLocalHumanRequest, proxyHumanEvidenceContent } from "../../../../../../../lib/human-operations-proxy";

export async function GET(request: NextRequest, context: { params: Promise<{ caseId: string; evidenceId: string }> }) {
  const authorization = authorizeLocalHumanRequest(request);
  if (authorization instanceof NextResponse) return authorization;
  const { caseId, evidenceId } = await context.params;
  return proxyHumanEvidenceContent({ assertion: authorization, path: `/v1/refund-cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(evidenceId)}/content` });
}
