import { NextRequest, NextResponse } from "next/server";

import { authorizeLocalHumanRequest, proxyHumanOperations } from "../../../lib/human-operations-proxy";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalHumanRequest(request);
  if (authorization instanceof NextResponse) return authorization;

  const search = request.nextUrl.search;
  return proxyHumanOperations({
    assertion: authorization,
    method: "GET",
    path: `/v1/refund-cases${search}`,
  });
}
