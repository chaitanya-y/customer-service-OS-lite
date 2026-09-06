import "server-only";

import { NextRequest, NextResponse } from "next/server";

export const LOCAL_HUMAN_SESSION_COOKIE = "cso_local_human_session";

const HUMAN_OPERATIONS_BASE_URL =
  process.env.HUMAN_OPERATIONS_BASE_URL ?? "http://127.0.0.1:3003";

type HumanAuthorization = Readonly<{ assertion: string }>;

function errorResponse(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function hasSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");

  return (
    origin === request.nextUrl.origin ||
    (process.env.NODE_ENV !== "production" && origin === "http://127.0.0.1:3101")
  );
}

export function isLocalHumanAuthenticationEnabled() {
  return process.env.NODE_ENV === "development" && Boolean(process.env.CSO_LOCAL_HUMAN_TOKEN);
}

export function authorizeLocalHumanRequest(
  request: NextRequest,
  options: Readonly<{ requireSameOrigin?: boolean }> = {},
): HumanAuthorization | NextResponse {
  const assertion = process.env.CSO_LOCAL_HUMAN_TOKEN;

  if (!isLocalHumanAuthenticationEnabled() || !assertion) {
    return errorResponse(
      503,
      "local_human_auth_unavailable",
      "Local staff authentication is unavailable.",
    );
  }

  if (request.cookies.get(LOCAL_HUMAN_SESSION_COOKIE)?.value !== "active") {
    return errorResponse(
      401,
      "human_unauthenticated",
      "Staff authentication is required.",
    );
  }

  if (options.requireSameOrigin && !hasSameOrigin(request)) {
    return errorResponse(403, "invalid_request_origin", "The request origin is not allowed.");
  }

  return { assertion };
}

export async function readJsonObject(request: NextRequest): Promise<string | NextResponse> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return errorResponse(415, "unsupported_media_type", "Requests must use application/json.");
  }

  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return errorResponse(400, "invalid_request_body", "Request body must be a JSON object.");
    }
    return JSON.stringify(body);
  } catch {
    return errorResponse(400, "invalid_request_body", "Request body must be valid JSON.");
  }
}

export async function proxyHumanOperations(input: Readonly<{
  assertion: HumanAuthorization;
  body?: string;
  idempotencyKey?: string;
  method: "GET" | "POST";
  path: string;
}>): Promise<NextResponse> {
  let endpoint: URL;
  try {
    endpoint = new URL(input.path, HUMAN_OPERATIONS_BASE_URL);
  } catch {
    return errorResponse(500, "human_operations_configuration_invalid", "Human Operations is not configured.");
  }

  try {
    const upstreamResponse = await fetch(endpoint, {
      method: input.method,
      body: input.body,
      cache: "no-store",
      headers: {
        accept: "application/json",
        "x-cso-human-assertion": input.assertion.assertion,
        ...(input.body ? { "content-type": "application/json" } : {}),
        ...(input.idempotencyKey ? { "idempotency-key": input.idempotencyKey } : {}),
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
    return errorResponse(502, "human_operations_unavailable", "Human Operations is temporarily unavailable.");
  }
}

export function getIdempotencyKey(request: NextRequest): string | NextResponse {
  const value = request.headers.get("idempotency-key");
  if (!value || value.length > 200) {
    return errorResponse(400, "idempotency_key_required", "An idempotency key is required.");
  }
  return value;
}

export async function proxyHumanEvidenceContent(input: { assertion: HumanAuthorization; path: string }): Promise<NextResponse> {
  try {
    const upstream = await fetch(new URL(input.path, HUMAN_OPERATIONS_BASE_URL), {
      cache: "no-store", headers: { "x-cso-human-assertion": input.assertion.assertion },
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return errorResponse(upstream.status, "evidence_unavailable", "This photo is unavailable. Refresh the case and try again.");
    }
    const contentType = upstream.headers.get("content-type");
    if (contentType !== "image/jpeg" && contentType !== "image/png") {
      await upstream.body?.cancel();
      return errorResponse(502, "evidence_unavailable", "This photo is unavailable.");
    }
    return new NextResponse(upstream.body, { headers: {
      "content-type": contentType, "cache-control": "private, no-store",
      "x-content-type-options": "nosniff", "content-disposition": "inline", "cross-origin-resource-policy": "same-origin",
    } });
  } catch { return errorResponse(502, "evidence_unavailable", "Photo viewing is temporarily unavailable."); }
}
