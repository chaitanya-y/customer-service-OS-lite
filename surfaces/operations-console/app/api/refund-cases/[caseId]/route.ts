import { NextRequest, NextResponse } from "next/server";

import { authorizeLocalHumanRequest, proxyHumanOperations } from "../../../../lib/human-operations-proxy";

type RouteContext = Readonly<{ params: Promise<{ caseId: string }> }>;

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const authorization = authorizeLocalHumanRequest(request);
  if (authorization instanceof NextResponse) return authorization;

  const { caseId } = await context.params;
  return proxyHumanOperations({
    assertion: authorization,
    method: "GET",
    path: `/v1/refund-cases/${encodeURIComponent(caseId)}`,
  });
}
