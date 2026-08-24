import { NextResponse } from "next/server";

import {
  isLocalHumanAuthenticationEnabled,
  LOCAL_HUMAN_SESSION_COOKIE,
} from "../../../lib/human-operations-proxy";

export async function POST() {
  if (!isLocalHumanAuthenticationEnabled()) {
    return NextResponse.json(
      { error: { code: "local_human_auth_unavailable", message: "Local staff authentication is unavailable." } },
      { status: 503 },
    );
  }

  const response = NextResponse.json({ data: { status: "authenticated" } });
  response.cookies.set({
    name: LOCAL_HUMAN_SESSION_COOKIE,
    value: "active",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
  return response;
}
