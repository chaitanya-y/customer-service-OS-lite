import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
  readIdempotencyKey,
  readJsonObject,
} from "../../../../../lib/refund-proxy";

type RouteContext = {
  params: Promise<{ conversationId: string }>;
};

export async function POST(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request, {
    requireSameOrigin: true,
  });
  if (authorization instanceof NextResponse) return authorization;

  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;

  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof NextResponse) return idempotencyKey;

  const { conversationId } = await context.params;
  return proxyEdgeApi({
    authorization,
    body,
    headers: { "idempotency-key": idempotencyKey },
    method: "POST",
    path: `/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
  });
}
