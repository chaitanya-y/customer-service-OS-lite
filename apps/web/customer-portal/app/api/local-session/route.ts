import {
  isLocalAuthenticationEnabled,
  LOCAL_CUSTOMER_SESSION_COOKIE,
} from "@cso/auth";
import { NextResponse } from "next/server";

export async function POST() {
  if (!isLocalAuthenticationEnabled({
    nodeEnv: process.env.NODE_ENV,
    localCustomerToken: process.env.CSO_LOCAL_CUSTOMER_TOKEN,
  })) {
    return NextResponse.json(
      { error: { code: "local_auth_unavailable", message: "Local authentication is unavailable." } },
      { status: 503 },
    );
  }

  const response = NextResponse.json({ data: { status: "authenticated" } });
  response.cookies.set({
    name: LOCAL_CUSTOMER_SESSION_COOKIE,
    value: "active",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
  });
  return response;
}
