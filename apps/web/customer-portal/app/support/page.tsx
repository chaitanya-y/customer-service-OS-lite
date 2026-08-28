import { LOCAL_CUSTOMER_SESSION_COOKIE } from "@cso/auth";
import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SupportChat } from "../../components/support-chat";

export default async function SupportPage() {
  const cookieStore = await cookies();

  if (cookieStore.get(LOCAL_CUSTOMER_SESSION_COOKIE)?.value !== "active") {
    redirect("/sign-in");
  }

  return (
    <main className="cso-page-shell">
      <header className="cso-topbar">
        <span className="cso-brand">Customer Service OS</span>
        <ThemeControl />
      </header>
      <SupportChat />
      <p className="cso-status-note">
        You are using a development-only local customer session.
      </p>
    </main>
  );
}
