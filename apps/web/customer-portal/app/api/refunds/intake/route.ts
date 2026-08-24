import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
  readJsonObject,
} from "../../../../lib/refund-proxy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request, {
    requireSameOrigin: true,
  });
  if (authorization instanceof NextResponse) return authorization;

  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;

  return proxyEdgeApi({
    authorization,
    body,
    method: "POST",
    path: "/v1/refunds/intake",
  });
}
