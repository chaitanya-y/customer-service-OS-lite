# Reference Document Manifest

Last updated: 2026-09-03

## Precedence

1. Accepted ADRs and `docs/architecture/KLEEM_AI_ARCHITECTURE_V1_1.md`
2. Current repository code and canonical contracts
3. Current handoff and runbook Markdown
4. Product PDFs
5. Version 1.0 architecture baseline appendix

If two sources conflict, use the higher-precedence source and record a new ADR for
any deliberate architecture change.

## Architecture files

- `architecture/Kleem_AI_Combined_HLD_and_LLD_Architecture.pdf` is the final
  version 1.1 combined PDF. It begins with the current amendment and includes the
  complete original document as a baseline appendix. Pages: 192. SHA-256:
  `06ce49530ee0df1feed291bca8ebb57e7b840c288a6a95e46ba0f8fffaee2cbf`.
- `architecture/Kleem_AI_Combined_HLD_and_LLD_Architecture_v1.0_baseline.pdf` is an
  immutable copy of the original 183-page architecture document. SHA-256:
  `dc336b4b3994736d4dc3f07bef0c649866ce5d98096f78f73c2ffb547fec1b71`.
- `../architecture/KLEEM_AI_ARCHITECTURE_V1_1.md` is the searchable authoritative
  source for current decisions.

## Product files

- `product/Customer_Agent_OS_Lite_Project_Overview.pdf`, 17 pages, SHA-256
  `d2fab8928e0e52233ad9684493e575a11a4cba6ec7793317855b621d0824732d`.
- `product/Customer_Agent_OS_Lite_V1_Product_Contract.pdf`, 18 pages, SHA-256
  `02684bfb805371aa9b0b5e4f424c924d8f07c98de9ff8adbe9e5b570f14fc56e`.
- `product/Customer_Agent_OS_Lite_Fixed_Product_Features.pdf`, 14 pages, SHA-256
  `544fdbf7b0550fb169ad6a77cdc37396b3f608ce4a38cf3b457c2ae1f852f189`.

These product PDFs remain useful. They describe intent and scope, while the current
architecture amendment records implementation changes made during the refund
walking skeleton.

## Excluded reference

`productionRAG.pdf` is not copied into the repository. It was used as a learning
reference, but its redistribution rights are not established. The project's own
RAG architecture and implementation are documented in the current architecture
source and code.

Never put credentials, tokens, `.env` files, local databases, or private customer
data in this directory.
