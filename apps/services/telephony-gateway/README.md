# Telephony Gateway — Planned

No implementation exists in this directory.

This future service will be the narrow provider boundary for real phone calls:
telephony webhooks, call lifecycle events, and bidirectional audio media streams.
It will authenticate the provider, establish tenant context, and pass normalized
voice events to `../voice-runtime/`.

It must not contain refund policy, RAG, or commerce-provider logic.
