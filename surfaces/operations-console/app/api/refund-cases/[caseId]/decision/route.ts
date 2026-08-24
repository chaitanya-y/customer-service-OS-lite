import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalHumanRequest,
  getIdempotencyKey,
  proxyHumanOperations,
  readJsonObject,
} from "../../../../../lib/human-operations-proxy";

type RouteContext = Readonly<{ params: Promise<{ caseId: string }> }>;

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const authorization = authorizeLocalHumanRequest(request, { requireSameOrigin: true });
  if (authorization instanceof NextResponse) return authorization;
  const idempotencyKey = getIdempotencyKey(request);
  if (idempotencyKey instanceof NextResponse) return idempotencyKey;
  const body = await readJsonObject(request);
  if (body instanceof NextResponse) return body;

  const { caseId } = await context.params;
  return proxyHumanOperations({
    assertion: authorization,
    body,
    idempotencyKey,
    method: "POST",
    path: `/v1/refund-cases/${encodeURIComponent(caseId)}/decision`,
  });
}
