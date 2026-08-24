"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  formatDate,
  formatMoney,
  normalizeHumanCaseList,
  type HumanCase,
} from "./human-case";
import { getConsoleData } from "./operations-api";
import styles from "./operations-console.module.css";

const filters = ["OPEN", "CLAIMED", "DECISION_PENDING", "CLOSED"] as const;

function CaseSummary({ refundCase }: Readonly<{ refundCase: HumanCase }>) {
  const amount = refundCase.reviewPacket.requestedAmount;
  return (
    <Link className={styles.caseRow} href={`/refund-cases/${encodeURIComponent(refundCase.caseId)}`}>
      <div>
        <span className={styles.caseType}>{refundCase.caseType === "REFUND_APPROVAL" ? "Approval review" : "Manual takeover"}</span>
        <strong>{refundCase.reviewPacket.orderReference ?? refundCase.workflowId}</strong>
        <span className={styles.muted}>{refundCase.reviewPacket.refundReason ?? "Refund review required"}</span>
      </div>
      <div className={styles.caseMeta}>
        <span className={`${styles.status} ${styles[`status${refundCase.status}`]}`}>{refundCase.status.replaceAll("_", " ")}</span>
        <span>{amount ? formatMoney(amount) : "Amount under review"}</span>
        <span>{formatDate(refundCase.createdAt)}</span>
      </div>
    </Link>
  );
}

export function RefundCaseQueue() {
  const [selectedStatus, setSelectedStatus] = useState<(typeof filters)[number]>("OPEN");
  const [refundCases, setRefundCases] = useState<HumanCase[] | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    setRefundCases(undefined);
    setError(undefined);
    void getConsoleData(`/api/refund-cases?status=${selectedStatus}`)
      .then((data) => { if (mounted) setRefundCases(normalizeHumanCaseList(data)); })
      .catch((requestError: unknown) => {
        if (mounted) setError(requestError instanceof Error ? requestError.message : "Unable to load the queue.");
      });
    return () => { mounted = false; };
  }, [selectedStatus]);

  return (
    <section className={styles.queue} aria-labelledby="queue-heading">
      <div className={styles.queueHeader}>
        <div>
          <span className="cso-eyebrow">Human Operations</span>
          <h1 id="queue-heading">Refund cases</h1>
          <p>Review governed approvals and manual takeovers with a complete audit trail.</p>
        </div>
        <div className={styles.filters} aria-label="Case status">
          {filters.map((status) => (
            <button
              aria-pressed={selectedStatus === status}
              className={selectedStatus === status ? styles.selectedFilter : styles.filter}
              key={status}
              onClick={() => setSelectedStatus(status)}
              type="button"
            >
              {status.replaceAll("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {refundCases === undefined ? <p className={styles.loading}>Loading refund cases…</p> : null}
      {refundCases?.length === 0 ? (
        <section className={styles.emptyState}>
          <h2>No {selectedStatus.toLowerCase().replaceAll("_", " ")} cases</h2>
          <p>New cases appear here once the refund workflow reaches a governed human decision point.</p>
        </section>
      ) : null}
      {refundCases?.length ? <div className={styles.caseList}>{refundCases.map((refundCase) => <CaseSummary key={refundCase.caseId} refundCase={refundCase} />)}</div> : null}
    </section>
  );
}
