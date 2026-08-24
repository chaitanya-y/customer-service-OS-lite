import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { RefundCaseQueue } from "../../components/refund-case-queue";
import { LOCAL_HUMAN_SESSION_COOKIE } from "../../lib/human-operations-proxy";

export default async function RefundCasesPage() {
  const cookieStore = await cookies();
  if (cookieStore.get(LOCAL_HUMAN_SESSION_COOKIE)?.value !== "active") redirect("/sign-in");

  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Operations</span><ThemeControl /></header><RefundCaseQueue /></main>;
}
