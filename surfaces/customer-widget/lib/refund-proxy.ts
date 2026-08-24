import "server-only";

import {
  isLocalAuthenticationEnabled,
  LOCAL_CUSTOMER_SESSION_COOKIE,
} from "@cso/auth";
import { NextRequest, NextResponse } from "next/server";

type LocalCustomerAuthorization = {
  authorization: string;
};

const EDGE_API_BASE_URL = process.env.EDGE_API_BASE_URL ?? "http://127.0.0.1:3000";

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: { "cache-control": "no-store" },
    },
  );
}

function hasSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");

  return (
    origin === request.nextUrl.origin ||
    (process.env.NODE_ENV !== "production" && origin === "http://127.0.0.1:3100")
  );
}

export function authorizeLocalCustomerRequest(
  request: NextRequest,
  options: { requireSameOrigin?: boolean } = {},
): LocalCustomerAuthorization | NextResponse {
  const localCustomerToken = process.env.CSO_LOCAL_CUSTOMER_TOKEN;

  if (
    !isLocalAuthenticationEnabled({
      nodeEnv: process.env.NODE_ENV,
      localCustomerToken,
    })
  ) {
    return errorResponse(
      503,
      "local_auth_unavailable",
      "Local customer authentication is unavailable.",
    );
  }

  if (
    request.cookies.get(LOCAL_CUSTOMER_SESSION_COOKIE)?.value !== "active"
  ) {
    return errorResponse(
      401,
      "customer_unauthenticated",
      "Customer authentication is required.",
    );
  }

  if (options.requireSameOrigin && !hasSameOrigin(request)) {
    return errorResponse(
      403,
      "invalid_request_origin",
      "The request origin is not allowed.",
    );
  }

  return { authorization: `Bearer ${localCustomerToken}` };
}

export async function readJsonObject(
  request: NextRequest,
): Promise<string | NextResponse> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return errorResponse(
      415,
      "unsupported_media_type",
      "Requests must use application/json.",
    );
  }

  try {
    const body: unknown = await request.json();

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse(
        400,
        "invalid_request_body",
        "Request body must be a JSON object.",
      );
    }

    return JSON.stringify(body);
  } catch {
    return errorResponse(
      400,
      "invalid_request_body",
      "Request body must be valid JSON.",
    );
  }
}

export async function proxyEdgeApi(input: {
  authorization: LocalCustomerAuthorization;
  body?: string;
  method: "GET" | "POST";
  path: string;
}): Promise<NextResponse> {
  let endpoint: URL;

  try {
    endpoint = new URL(input.path, EDGE_API_BASE_URL);
  } catch {
    return errorResponse(
      500,
      "edge_api_configuration_invalid",
      "The support service is not configured.",
    );
  }

  try {
    const upstreamResponse = await fetch(endpoint, {
      method: input.method,
      body: input.body,
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: input.authorization.authorization,
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
    });
    const responseBody = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type");

    return new NextResponse(responseBody, {
      status: upstreamResponse.status,
      headers: {
        "cache-control": "no-store",
        ...(contentType ? { "content-type": contentType } : {}),
      },
    });
  } catch {
    return errorResponse(
      502,
      "edge_api_unavailable",
      "The support service is temporarily unavailable.",
    );
  }
}
