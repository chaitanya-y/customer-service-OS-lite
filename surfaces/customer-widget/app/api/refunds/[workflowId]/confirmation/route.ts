import { NextRequest, NextResponse } from "next/server";

import {
  authorizeLocalCustomerRequest,
  proxyEdgeApi,
  readJsonObject,
} from "../../../../../lib/refund-proxy";

type RouteContext = {
  params: Promise<{ workflowId: string }>;
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

  const { workflowId } = await context.params;
  return proxyEdgeApi({
    authorization,
    body,
    method: "POST",
    path: `/v1/refunds/${encodeURIComponent(workflowId)}/confirmation`,
  });
}
