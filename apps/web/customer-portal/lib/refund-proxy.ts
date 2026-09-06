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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function readIdempotencyKey(
  request: NextRequest,
): string | NextResponse {
  const idempotencyKey = request.headers.get("idempotency-key");

  if (!idempotencyKey || !UUID_PATTERN.test(idempotencyKey)) {
    return errorResponse(
      400,
      "invalid_idempotency_key",
      "Requests must include a valid idempotency key.",
    );
  }

  return idempotencyKey;
}

export async function proxyEdgeApi(input: {
  authorization: LocalCustomerAuthorization;
  body?: string;
  headers?: Readonly<Record<string, string>>;
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
        ...input.headers,
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

export async function proxyEdgeEvidence(input: {
  authorization: LocalCustomerAuthorization;
  path: string;
  body?: ArrayBuffer;
  headers?: Record<string, string>;
}): Promise<NextResponse> {
  try {
    const upstream = await fetch(new URL(input.path, EDGE_API_BASE_URL), {
      method: input.body ? "POST" : "GET",
      body: input.body,
      cache: "no-store",
      headers: { authorization: input.authorization.authorization, ...input.headers },
    });
    if (input.body) {
      return new NextResponse(await upstream.text(), { status: upstream.status,
        headers: { "cache-control": "no-store", "content-type": "application/json" } });
    }
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return errorResponse(upstream.status, "evidence_unavailable", "This photo is not available. Refresh and try again.");
    }
    const contentType = upstream.headers.get("content-type");
    if (contentType !== "image/jpeg" && contentType !== "image/png") {
      await upstream.body?.cancel();
      return errorResponse(502, "evidence_unavailable", "This photo is not available.");
    }
    return new NextResponse(upstream.body, { headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
      "cross-origin-resource-policy": "same-origin",
    } });
  } catch {
    return errorResponse(502, "evidence_unavailable", "Photo uploads and viewing are temporarily unavailable.");
  }
}

/**
 * Streams a customer-authorized Edge event feed without ever exposing the
 * server-held local customer token to the browser.
 */
export async function proxyEdgeEventStream(input: {
  authorization: LocalCustomerAuthorization;
  lastEventId?: string;
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
      cache: "no-store",
      headers: {
        accept: "text/event-stream",
        authorization: input.authorization.authorization,
        ...(input.lastEventId ? { "last-event-id": input.lastEventId } : {}),
      },
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const responseBody = await upstreamResponse.text();
      const contentType = upstreamResponse.headers.get("content-type");

      return new NextResponse(responseBody, {
        status: upstreamResponse.status,
        headers: {
          "cache-control": "no-store",
          ...(contentType ? { "content-type": contentType } : {}),
        },
      });
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("text/event-stream")) {
      return errorResponse(
        502,
        "edge_api_event_stream_invalid",
        "The support service returned an invalid update stream.",
      );
    }

    return new NextResponse(upstreamResponse.body, {
      headers: {
        "cache-control": "no-cache, no-store, must-revalidate",
        connection: "keep-alive",
        "content-type": "text/event-stream",
        "x-accel-buffering": "no",
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
