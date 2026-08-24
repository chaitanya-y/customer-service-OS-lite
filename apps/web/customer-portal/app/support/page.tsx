import { LOCAL_CUSTOMER_SESSION_COOKIE } from "@cso/auth";
import { ThemeControl } from "@cso/ui";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SupportRequestForm } from "../../components/support-request-form";

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
      <section className="cso-panel cso-support-panel" aria-labelledby="support-heading">
        <span className="cso-eyebrow">Support</span>
        <h1 id="support-heading">Tell us what happened.</h1>
        <p>
          We will review your request and show the exact amount before anything
          is submitted.
        </p>
        <SupportRequestForm />
        <p className="cso-status-note">
          You are using a development-only local customer session.
        </p>
      </section>
    </main>
  );
}
