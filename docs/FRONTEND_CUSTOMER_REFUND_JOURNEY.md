# Customer Widget: Refund Journey UX Design

## Purpose

This document defines the first browser journey for Customer Service OS Lite:
a customer requests a refund, reviews an exact preview, explicitly confirms or
declines it, and sees authoritative progress.

This is a hosted support portal, not an embeddable third-party widget in the
first release. The customer application talks only to its Next.js BFF, which
calls the Edge API. It never calls Temporal, Vendure, OpenSearch, MCP, or an
internal service directly.

## Scope

### In scope

- customer support entry and refund request;
- typed refund proposal and exact refund preview;
- customer confirmation or decline;
- authoritative workflow status and timeline;
- customer-safe RAG citations when supplied by the Agent Runtime;
- light, dark, and system themes;
- loading, retry, unavailable, and human-review states.

### Out of scope

- a generic chat platform or historical conversation inbox;
- an embedded merchant-site widget;
- customer account registration and password recovery UX;
- refund cancellation after provider submission;
- agent/policy/knowledge administration UI.

## Customer routes

| Route | Purpose | Authentication |
|---|---|---|
| `/support` | Request support or a refund | customer session required |
| `/refunds/[workflowId]` | Review a refund journey and its live status | customer must own the journey |
| `/auth/callback` | OIDC sign-in callback | internal only |

`/support` is the entry route. When the server creates a refund workflow, the
application navigates to `/refunds/[workflowId]`. A customer may only load a
journey whose tenant, environment, and customer identity match their trusted
server-side session.

## Journey flow

```text
1. Customer enters a request
       "Order QXB4NEW2EPG6YJ7Q arrived damaged. I want a refund."

2. Customer Widget submits the request
       POST /api/refunds/intake

3. Edge API authenticates the customer and invokes the governed runtime
       → Agent Runtime, RAG, read-only order lookup, Temporal workflow

4. Widget receives either a clarification state or a workflow identifier
       → navigate to /refunds/:workflowId when workflow starts

5. Widget loads the customer-safe RefundJourneyView
       GET /api/refund-journeys/:workflowId

6. Customer reviews the exact preview and chooses Confirm or Decline
       POST /api/refund-journeys/:workflowId/confirmation

7. Widget receives real-time status events and refreshes its journey view
       GET /api/refund-journeys/:workflowId/events (SSE)

8. Workflow reaches a final, human-review, or reconciliation state
```

## Screen 1: Support entry

### Goal

Let the customer explain the issue without requiring them to understand order
identifiers, policies, tools, or workflow concepts.

### Layout

```text
┌────────────────────────────────────────────────────────────────────┐
│ Customer Service OS                                  Theme · Profile │
├────────────────────────────────────────────────────────────────────┤
│ Need help with an order?                                             │
│ Tell us what happened.                                               │
│                                                                      │
│ ┌────────────────────────────────────────────────────────────────┐ │
│ │ My order QXB4NEW2EPG6YJ7Q arrived damaged. I need a refund.    │ │
│ └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ Optional order reference                                             │
│ [ QXB4NEW2EPG6YJ7Q                                             ]     │
│                                                                      │
│                                                [Continue]            │
│                                                                      │
│ We will review your request and show the exact amount before         │
│ anything is submitted.                                               │
└────────────────────────────────────────────────────────────────────┘
```

### Interaction rules

- `customer_message` is required, maximum 2,000 characters.
- `order_reference` is optional, maximum 100 characters.
- Disable **Continue** while the request is in flight, but keep the entered text
  visible if the request fails.
- Create an idempotency key per deliberate submit. A retry of the same submit
  keeps that key; a newly edited request receives a new key.
- Do not say a refund is approved at this stage.

### Existing API

The Next.js BFF proxies the existing Edge route:

```http
POST /v1/refunds/intake
Authorization: server-managed customer credential

{
  "customer_message": "Order QXB4NEW2EPG6YJ7Q arrived damaged. I need a refund.",
  "order_reference": "QXB4NEW2EPG6YJ7Q"
}
```

The current Edge API already validates this body, derives identity from the
customer credential, and starts the workflow only after a valid proposal is
available.

## Screen 2: Refund journey

### Goal

Make the customer understand what will happen, why, and what they need to do.

### Layout

```text
┌────────────────────────────────────────────────────────────────────┐
│ ← Support                 Refund request                             │
├───────────────────────────────────────┬────────────────────────────┤
│ Refund ready for confirmation          │ Progress                   │
│                                       │ ● Request received          │
│ Refund amount                          │ ● Refund preview ready     │
│ $27.79 USD                             │ ○ Awaiting confirmation    │
│                                       │ ○ Submitted                 │
│ Reason                                 │                            │
│ Item arrived damaged                   │ Need help?                 │
│                                       │ Ask for a human review      │
│ Order QXB4NEW2EPG6YJ7Q                │                            │
│                                       │                            │
│ Based on the current refund policy     │                            │
│ [Current refund policy ↗]              │                            │
│                                       │                            │
│ [Decline]              [Confirm refund]│                            │
└───────────────────────────────────────┴────────────────────────────┘
```

### Confirmation behavior

**Confirm refund** is available only when `next_action` is
`CONFIRM_OR_DECLINE` and the preview is current.

```http
POST /v1/refunds/:workflowId/confirmation

{
  "preview_id": "preview-456",
  "accepted": true
}
```

The workflow verifies that the preview, policy decision, and authoritative facts
still match. The button does not directly call Vendure or issue a refund.

The decline action sends the same request with `accepted: false` and then renders
the journey as closed, with clear guidance for starting another request if needed.

### Customer-safe citations

When the response includes RAG evidence, show a short source label and expandable
excerpt. Never show content classified as `INTERNAL` or raw retrieval metadata.

Example:

```text
Based on the current refund policy
Source: Current refund policy, effective Aug 1, 2026
```

## Screen 3: Human review and recovery states

The customer does not need to understand `APPROVAL_REQUIRED`,
`TAKEOVER_REQUIRED`, or `PENDING_RECONCILIATION`.

| Internal state | Customer label | Customer explanation | Action |
|---|---|---|---|
| `APPROVAL_REQUIRED` | Under review | A specialist is reviewing your request. | View progress |
| `TAKEOVER_REQUIRED` | A specialist is helping | Your request needs personal support. | View progress / support contact |
| `PENDING_RECONCILIATION` | We are confirming the refund | We received your request and are confirming its final status. | View progress |
| `REFUND_SUCCEEDED` | Refund submitted | Your refund has been submitted. Your payment provider may take time to display it. | View receipt/details |
| `DENY` | Refund request could not be approved | Explain the customer-safe reason and provide a support path. | Start new request / contact support |

The UI must not infer success from a button click, an accepted confirmation, or a
temporary provider response. Only authoritative workflow state can mark the
journey complete.

## Customer-safe journey contract

The current workflow-status endpoint is useful for testing but is not the long-term
browser contract. Add an Edge-owned journey projection before the UI is built.

```ts
type RefundJourneyView = {
  journeyId: string;
  journeyType: "REFUND";
  status: {
    code:
      | "AWAITING_CUSTOMER_CONFIRMATION"
      | "UNDER_REVIEW"
      | "CONFIRMING_REFUND"
      | "REFUND_SUBMITTED"
      | "COMPLETED"
      | "CLOSED";
    label: string;
    detail: string;
  };
  preview?: {
    previewId: string;
    amount: { amountMinor: number; currency: string };
    reasonLabel: string;
    expiresAt?: string;
  };
  nextAction: "CONFIRM_OR_DECLINE" | "WAIT" | "NONE";
  citations: Array<{
    documentTitle: string;
    excerpt?: string;
    effectiveAt?: string;
  }>;
  timeline: Array<{
    eventId: string;
    occurredAt: string;
    label: string;
    detail?: string;
  }>;
  updatedAt: string;
  meta: { requestId: string; apiVersion: string };
};
```

This projection is owned by Edge API. It transforms internal workflow data into a
stable, customer-safe representation and authorizes access using the customer
session.

## Real-time behavior

1. The route loads `RefundJourneyView` first.
2. A same-origin SSE connection subscribes to this journey.
3. Each event invalidates only the matching TanStack Query cache entry.
4. The refreshed journey view remains the authority for screen content.
5. If SSE disconnects, the page polls the journey view every 10 seconds with an
   unobtrusive “Reconnecting updates” status.

Public event payloads contain event type, ID, time, and journey ID only. They do
not contain raw tool calls, payment data, internal policy facts, or RAG passages.

## Component inventory

| Component | Responsibility |
|---|---|
| `SupportRequestForm` | customer message, optional order reference, submit state |
| `RefundJourneyHeader` | customer-safe status label and summary |
| `RefundPreviewCard` | exact amount, reason, order reference, confirm/decline |
| `JourneyTimeline` | ordered authoritative progress events |
| `CitationList` | customer-safe policy source references |
| `JourneyStatusBanner` | review, recovery, unavailable, or completed explanation |
| `ThemeControl` | light, dark, or system preference |
| `ErrorState` | retryable error with preserved customer input |

These are presentation components. They do not contain authorization, policy, or
refund-execution logic.

## Error and empty states

| Situation | Customer message | UI behavior |
|---|---|---|
| Session expired | Please sign in again to continue. | Preserve local draft, redirect to sign-in |
| Agent Runtime unavailable | We cannot review this request right now. Please try again. | Retry button, no fake result |
| Workflow unavailable | We are having trouble loading your refund status. | Retry and support path |
| Stale preview | Your refund details changed. Please review the new amount. | Remove confirmation action until new preview loads |
| SSE disconnected | Live updates are reconnecting. | Continue displaying last authoritative view and poll |
| No matching order | We could not find that order. Check the order reference or contact support. | Preserve request draft |

## Acceptance criteria

1. A customer can submit a valid refund request and reach the workflow route.
2. A customer can see only a journey they own.
3. A customer sees an exact amount before confirmation.
4. Confirm and decline require the exact current `preview_id`.
5. A refresh or repeated click does not submit duplicate confirmation intent.
6. Human-review and reconciliation states have customer-safe language.
7. The page works in light, dark, and system themes.
8. Keyboard-only users can submit, review, confirm, and read status changes.
9. An SSE update refreshes the visible journey without losing form state or scroll
   position.
10. Browser telemetry includes request/trace correlation but not customer messages,
    payment data, or internal evidence.

## Implementation sequence

1. Scaffold the shared Next.js frontend foundation and `@cso/ui` tokens.
2. Add the local customer session adapter and BFF routes that proxy the existing
   Edge intake, status, and confirmation APIs.
3. Implement `SupportRequestForm` and the polling-based journey screen.
4. Add Edge-owned `RefundJourneyView` projection.
5. Add the SSE journey-events endpoint and client reconnection behavior.
6. Add component, contract, accessibility, and Playwright end-to-end tests.

The first implementation milestone ends after step 3: a local authenticated
customer can request a refund, confirm the exact preview, and see authoritative
status. SSE and the richer journey projection are the next hardening increment,
not reasons to delay the initial customer UI.
