# Services

Each folder here is an independently runnable service or worker. The existing chat
and refund workloads remain intentionally separate from the future voice workloads:

- `telephony-gateway/` will own the phone-provider webhook and media-stream boundary.
- `voice-runtime/` will own speech-specific orchestration: turn detection,
  interruption handling, transcription, and speech synthesis.
- `voice-evaluation/` will own call-specific quality and safety evaluation.

Those directories contain no implementation yet. Voice must use the existing
contracts, policy workflow, RAG service, human operations service, and integration
gateway rather than duplicating customer-service business logic.
