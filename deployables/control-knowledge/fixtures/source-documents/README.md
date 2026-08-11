# RAG source-document fixtures

These files are deliberately small, consistent source inputs for the first Customer Service OS RAG ingestion exercise.

The PDF, DOCX, Markdown, and HTML versions of the refund policy express the same policy. They are parser fixtures, **not** four independent documents to ingest into the same knowledge release. Ingest one representation per release so duplicate content does not distort retrieval results.

The first corpus contains customer-safe refund-policy content for the fictional `acme` tenant and the `local` environment. It is designed to support questions about damaged items, return windows, refund amounts, approval boundaries, and policy citations.
