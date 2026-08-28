import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeEventStream,
} from "../../../../../lib/refund-proxy";

type RouteContext = {
  params: Promise<{ workflowId: string }>;
};

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  const authorization = authorizeLocalCustomerRequest(request);
  if (authorization instanceof NextResponse) return authorization;

  const { workflowId } = await context.params;
  return proxyEdgeEventStream({
    authorization,
    lastEventId: request.headers.get("last-event-id") ?? undefined,
    path: `/v1/refunds/${encodeURIComponent(workflowId)}/events`,
  });
}
