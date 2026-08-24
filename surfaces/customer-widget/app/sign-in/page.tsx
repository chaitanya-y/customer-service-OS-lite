"use client";

import { useState } from "react";

export default function SignInPage() {
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function startLocalSession() {
    setSubmitting(true);
    setError(undefined);
    const response = await fetch("/api/local-session", { method: "POST" });

    if (!response.ok) {
      setSubmitting(false);
      setError("Local customer authentication is not configured.");
      return;
    }

    window.location.assign("/support");
  }

  return (
    <main className="cso-page-shell">
      <section className="cso-panel">
        <span className="cso-eyebrow">Customer Service OS</span>
        <h1>Start local support</h1>
        <p>
          This development-only page creates a local session. Cognito replaces it
          in the AWS deployment without changing the support route.
        </p>
        {error ? <p className="cso-status-note" role="alert">{error}</p> : null}
        <button className="cso-primary-button" disabled={submitting} onClick={startLocalSession} type="button">
          {submitting ? "Starting session…" : "Continue locally"}
        </button>
      </section>
    </main>
  );
}
