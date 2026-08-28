# Customer Widget: Refund Journey UX Design

## Purpose

This document records the first implemented browser journey for Customer Service
OS Lite and the next UI hardening steps. A customer requests a refund, reviews an
exact preview when policy permits it, explicitly confirms or declines it, and sees
an authoritative workflow state.

This is a hosted support portal, not an embeddable third-party widget in the
first release. The customer application talks only to its Next.js BFF, which
calls the Edge API. It never calls Temporal, Vendure, OpenSearch, MCP, or an
internal service directly.

## Scope

### In scope

- persisted customer support chat and refund request;
- typed refund proposal and exact refund preview;
- customer confirmation or decline;
- authoritative workflow status and a current-state progress display;
- defensive customer-safe citation rendering when a future journey projection
  supplies citations;
- light, dark, and system themes;
- loading, retry, unavailable, and human-review states;
- local customer sign-in and same-origin BFF proxy routes for development.

### Out of scope

- an embedded merchant-site widget;
- customer account registration and password recovery UX;
- production OIDC/Cognito UI, although the route boundary is designed to support it;
- refund cancellation after provider submission;
- agent/policy/knowledge administration UI.

## Customer routes

| Route | Purpose | Authentication |
|---|---|---|
| `/sign-in` | Development-only local customer session | local token configured on the server |
| `/support` | Customer-safe chat transcript, support request, and refund entry | customer session required |
| `/refunds/[workflowId]` | Review a refund journey and its live status | customer must own the journey |

`/support` is the conversation entry route. It stores only the current
conversation identifier in browser session storage; Conversation Runtime remains
the encrypted transcript authority. When Edge API starts a refund workflow, the
assistant message includes a link to `/refunds/[workflowId]`. The BFF forwards the
server-held local customer token to Edge API, which verifies customer ownership.
The browser never receives that token or an internal service assertion.

## Journey flow

```text
1. Customer sends a chat message
       "Order QXB4NEW2EPG6YJ7Q arrived damaged. I want a refund."

2. Customer Portal lazily creates a conversation, then submits through its
   same-origin BFF
       POST /api/conversations
       POST /api/conversations/:conversationId/messages

3. Edge API authenticates the customer, persists the customer message, invokes
   the governed runtime, and commits its customer-safe answer
       → Conversation Runtime, Agent Runtime, RAG, read-only order lookup

4. The chat shows the persisted assistant answer. A ready proposal starts a
   Temporal workflow and adds a refund-journey link to that answer.

5. Widget loads current workflow state through its BFF
       GET /api/refunds/:workflowId

6. Customer reviews the exact preview and chooses Confirm or Decline
       POST /api/refunds/:workflowId/confirmation

7. Widget refreshes after customer confirmation. After an external human decision,
   the customer refreshes the page to load the authoritative workflow state.

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
- The form creates a UI-scoped idempotency key per deliberate submit. The current
  BFF and Edge intake route do not yet enforce that key end to end, so browser
  mutation idempotency remains a hardening task.
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

`customer-api.ts` defensively rejects citations classified as `INTERNAL` or
`INTERNAL_ONLY`. The current workflow-status route does not yet return citations,
so the visible citation block is reserved for the future Edge journey projection.
When that projection includes RAG evidence, show a short source label and
expandable excerpt, never raw retrieval metadata.

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
| `REFUND_PROCESSING` or `PENDING_RECONCILIATION` | Refund initiated | Your refund was sent to the payment provider. We will update this page when its final status is confirmed. | View progress |
| `REFUND_SUCCEEDED` | Refund completed | The payment provider confirmed the refund. The customer bank may still need a few business days to show it. | View receipt/details |
| `DENY` | Refund request could not be approved | Explain the customer-safe reason and provide a support path. | Start new request / contact support |

The UI must not infer success from a button click, an accepted confirmation, or a
temporary provider response. Only authoritative workflow state can mark the
journey complete.

## Current customer-safe journey contract

The Customer Widget is built. Its BFF proxies the customer-owned Edge route and
normalizes the current Temporal workflow result into display-safe data. The browser
does not receive internal assertions, raw policy input, or tool payloads.

The current Edge response is intentionally narrow:

```ts
type RefundWorkflowView = {
  workflow_id: string;
  stage:
    | "AWAITING_CUSTOMER_CONFIRMATION"
    | "AWAITING_APPROVAL"
    | "HUMAN_TAKEOVER_REQUIRED"
    | "REFUND_PROCESSING"
    | "REFUND_SUCCEEDED"
    | "PENDING_RECONCILIATION"
    | "DENIED"
    | "CANCELLED"
    | "REJECTED"
    | "TAKEOVER_RESOLVED";
  preview?: {
    previewId: string;
    requestedAmount: { amountMinor: number; currency: string };
    refundDestination: string;
    validUntil: string;
  };
};
```

`apps/web/customer-portal/components/customer-api.ts` maps this response to the
plain-language labels shown to the customer. It also rejects citations with
`INTERNAL` or `INTERNAL_ONLY` classification before rendering.

The Edge-owned, versioned `RefundJourneyView` projection provides the stable
browser shape, customer safe timeline, API versioning, and no raw workflow state.

## Real-time behavior

The journey uses a same origin SSE endpoint that emits only a journey ID, event
ID, type, and timestamp. Each event causes a refetch of the authoritative journey
view. It never carries raw tool calls, payment data, policy facts, or RAG passages.
If SSE disconnects, the browser polls the journey view every ten seconds with a
quiet reconnecting status.

## Component inventory

| Component | Responsibility |
|---|---|
| `SupportChat` | implemented encrypted transcript view, customer composer, optional order reference, pending/error state, and inline workflow link |
| `conversation-api.ts` | defensive mapping of customer-safe conversation and turn responses |
| `RefundJourney` | implemented customer-safe status, exact preview, confirmation, optional future citations, and fallback timeline |
| `customer-api.ts` | implemented conversion of untrusted API JSON into customer display data and safe status copy |
| Customer BFF route handlers | implemented local-session authorization and Edge API proxying |
| `ThemeControl` | light, dark, or system preference |
| Inline error states | retryable error; form input is preserved while the page remains open |

The React components do not contain authorization, policy, or refund-execution
logic. The BFF routes supply server-side local session checks and forward the
server-held development token to Edge API.

## Error and empty states

| Situation | Customer message | UI behavior |
|---|---|---|
| Session expired | Please sign in again to continue. | Redirect to sign-in; draft persistence across navigation is not implemented |
| Agent Runtime unavailable | We cannot review this request right now. Please try again. | Retry button, no fake result |
| Workflow unavailable | We are having trouble loading your refund status. | Retry and support path |
| Stale preview | Your refund details changed. Please review the new amount. | Remove confirmation action until new preview loads |
| Human decision happens in Operations Console | A specialist is reviewing your request. | Customer refreshes the journey page to load the latest state |
| No matching order | We could not find that order. Check the order reference or contact support. | Preserve request draft |

## Acceptance status

| Requirement | Current status |
|---|---|
| Persist a customer/assistant chat turn and reload the transcript | Implemented |
| Submit an authenticated refund request and reach the workflow route | Implemented |
| Restrict reads to the customer who owns the workflow | Implemented at Edge API |
| Show an exact amount before confirmation | Implemented when the workflow creates a preview |
| Bind confirm/decline to the exact `preview_id` | Implemented |
| Use customer-safe labels for human review and reconciliation | Implemented |
| Light, dark, and system themes | Implemented |
| Keyboard focus and basic accessible status/error regions | Implemented foundation, needs formal accessibility testing |
| Duplicate confirmation protection | Enforced by workflow semantics, needs browser end-to-end coverage |
| Live SSE updates with polling fallback | Implemented |
| Browser telemetry without sensitive content | Planned |

## Delivery sequence

Completed:

1. Shared Next.js frontend foundation, semantic theme tokens, and `@cso/ui`.
2. Development-only customer session adapter and BFF routes for Edge intake,
   workflow status, and confirmation.
3. Customer support form and authoritative workflow-status page.
4. Human Operations queue, case detail, claim, decision, and audit views.

Next hardening increment:

1. Add component, accessibility, and browser end-to-end tests.
2. Add a visible customer receipt or provider reference where appropriate.
3. Replace local sessions with Cognito while preserving the BFF boundaries.
