import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
  readIdempotencyKey,
  readJsonObject,
} from "../../../lib/refund-proxy";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request, {
    requireSameOrigin: true,
  });
  if (authorization instanceof NextResponse) return authorization;

  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;

  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof NextResponse) return idempotencyKey;

  return proxyEdgeApi({
    authorization,
    body,
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
    path: "/v1/conversations",
  });
}
