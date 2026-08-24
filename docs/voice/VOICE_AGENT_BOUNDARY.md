# Voice-agent architecture boundary

Voice is a new channel for the same governed customer-service platform, not a
second customer-service implementation. No telephony or voice code has been added
yet.

## Future ownership

| Workload | Responsibility | Does not own |
| --- | --- | --- |
| `apps/services/telephony-gateway` | Phone-provider webhooks, call lifecycle, audio media ingress and egress | Customer-service reasoning or refund execution |
| `apps/services/voice-runtime` | Transcription, text-to-speech, turn-taking, interruptions, and call-state coordination | A duplicate refund graph, policy engine, RAG pipeline, or commerce connector |
| `apps/services/voice-evaluation` | Call-specific quality, safety, latency, and handoff evaluation | Production call routing |

## Reuse instead of duplication

The voice runtime should invoke the existing services through their contracts:

- `agent-runtime` for LangGraph specialist routing, guardrails, structured
  proposals, and answer composition;
- `knowledge-rag` for tenant-scoped retrieval and citations;
- `workflow-workers` for deterministic policy, approvals, and refund execution;
- `human-operations` for takeover and human decisions;
- `integration-gateway` for MCP tools and authorized Vendure access;
- `conversation-runtime` for canonical conversation history and ordering;
- existing authentication and trusted-context assertions for tenant isolation.

The current Edge API and Next.js customer portal are chat-oriented HTTP/SSE
surfaces. They are not a real-time phone-audio transport and should not be copied
into the voice folders. A later telephony gateway will be the only phone-provider
adapter.

## Design rule

Both channels may have different input/output mechanics, but any action that can
affect a customer—such as a refund—must still produce the same evidence, pass the
same deterministic policy, and use the same human-approval gates.
