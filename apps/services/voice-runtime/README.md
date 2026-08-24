# Voice Runtime — Planned

No implementation exists in this directory.

This future Python workload will own speech-specific behavior: transcription,
turn-taking, barge-in/interruption handling, speech synthesis, and call-state
coordination. It will call the existing `../agent-runtime/` for customer-service
reasoning, tool use, guardrails, and structured refund proposals.

It must not copy the chat agent graph or the refund workflow. The same knowledge,
policy, human-approval, and integration boundaries must apply to both chat and
voice channels.
