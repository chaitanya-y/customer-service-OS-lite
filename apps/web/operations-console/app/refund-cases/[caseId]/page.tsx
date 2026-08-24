import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { RefundCaseDetail } from "../../../components/refund-case-detail";
import { LOCAL_HUMAN_SESSION_COOKIE } from "../../../lib/human-operations-proxy";

export default async function RefundCasePage({ params }: Readonly<{ params: Promise<{ caseId: string }> }>) {
  const [{ caseId }, cookieStore] = await Promise.all([params, cookies()]);
  if (cookieStore.get(LOCAL_HUMAN_SESSION_COOKIE)?.value !== "active") redirect("/sign-in");
  if (!caseId || caseId.length > 200) notFound();

  return <main className="cso-page-shell"><header className="cso-topbar"><span className="cso-brand">Customer Service OS · Operations</span><ThemeControl /></header><RefundCaseDetail caseId={caseId} /></main>;
}
