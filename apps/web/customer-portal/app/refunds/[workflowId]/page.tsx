import { LOCAL_CUSTOMER_SESSION_COOKIE } from "@cso/auth";
import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RefundJourney } from "../../../components/refund-journey";

export default async function RefundJourneyPage({
  params,
}: Readonly<{ params: Promise<{ workflowId: string }> }>) {
  const [{ workflowId }, cookieStore] = await Promise.all([params, cookies()]);

  if (cookieStore.get(LOCAL_CUSTOMER_SESSION_COOKIE)?.value !== "active") {
    redirect("/sign-in");
  }
  if (!workflowId || workflowId.length > 200) notFound();

  return (
    <main className="cso-page-shell">
      <header className="cso-topbar">
        <Link className="cso-brand" href="/support">Customer Service OS</Link>
        <ThemeControl />
      </header>
      <RefundJourney workflowId={workflowId} />
    </main>
  );
}
