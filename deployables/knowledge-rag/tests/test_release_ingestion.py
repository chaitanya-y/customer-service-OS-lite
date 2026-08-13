from pathlib import Path

import pytest

from knowledge_rag.embeddings import DeterministicEmbeddingProvider
from knowledge_rag.ingestion import (
    KnowledgeDocumentClassification,
    SourceContentHashMismatchError,
)
from knowledge_rag.opensearch_indexing import BulkIndexResult
from knowledge_rag.opensearch_schema import OpenSearchIndexConfig
from knowledge_rag.release_ingestion import (
    ReleaseCompilationError,
    compile_knowledge_release,
    publish_knowledge_release,
)
from knowledge_rag.source_registry import (
    load_knowledge_release_manifest,
)

FIXTURES_PATH = Path(__file__).resolve().parents[1] / "fixtures"

MANIFEST_PATH = (
    FIXTURES_PATH
    / "source-registrations"
    / "acme"
    / "refund-knowledge-release-v1.json"
)

CURRENT_POLICY_URI = (
    "s3://cso-knowledge/acme/refund-policy-2026-08-01.md"
)
INTERNAL_PLAYBOOK_URI = (
    "s3://cso-knowledge/acme/internal-refund-escalation-playbook.md"
)
SUPERSEDED_POLICY_URI = (
    "s3://cso-knowledge/acme/refund-policy-2026-07-01.md"
)

CURRENT_POLICY_PATH = (
    Path(__file__).resolve().parents[2]
    / "control-knowledge"
    / "fixtures"
    / "source-documents"
    / "acme"
    / "refund-policy-2026-08-01.md"
)

INTERNAL_PLAYBOOK_PATH = (
    FIXTURES_PATH
    / "source-documents"
    / "acme"
    / "internal-refund-escalation-playbook.md"
)

SUPERSEDED_POLICY_PATH = (
    FIXTURES_PATH
    / "source-documents"
    / "acme"
    / "refund-policy-superseded-2026-07-01.md"
)


class FakeSourceUriResolver:
    def __init__(self, paths_by_uri: dict[str, Path]) -> None:
        self._paths_by_uri = paths_by_uri
        self.resolved_uris: list[str] = []

    def resolve(self, source_uri: str) -> Path:
        self.resolved_uris.append(source_uri)
        return self._paths_by_uri[source_uri]


def make_resolver() -> FakeSourceUriResolver:
    return FakeSourceUriResolver(
        {
            CURRENT_POLICY_URI: CURRENT_POLICY_PATH,
            INTERNAL_PLAYBOOK_URI: INTERNAL_PLAYBOOK_PATH,
            SUPERSEDED_POLICY_URI: SUPERSEDED_POLICY_PATH,
        }
    )


def test_compile_knowledge_release_creates_governed_index_documents() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)
    embedding_provider = DeterministicEmbeddingProvider(dimension=8)

    compilation = compile_knowledge_release(
        manifest=manifest,
        source_uri_resolver=make_resolver(),
        embedding_provider=embedding_provider,
        ingestion_job_id="release-ingestion-001",
    )

    assert compilation.knowledge_release_id == "refund-policy-2026-08-01"
    assert compilation.embedding_model == embedding_provider.model
    assert len(compilation.artifacts) == 3
    assert compilation.index_documents
    assert all(
        document.knowledge_release_id == manifest.knowledge_release_id
        for document in compilation.index_documents
    )
    assert all(
        len(document.embedding_vector) == 8
        for document in compilation.index_documents
    )
    assert {
        document.classification for document in compilation.index_documents
    } == {
        KnowledgeDocumentClassification.CUSTOMER_SAFE,
        KnowledgeDocumentClassification.INTERNAL,
    }


def test_compile_knowledge_release_rejects_a_source_with_changed_content() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)
    resolver = make_resolver()
    resolver._paths_by_uri[INTERNAL_PLAYBOOK_URI] = (
        SUPERSEDED_POLICY_PATH
    )

    with pytest.raises(
        SourceContentHashMismatchError,
        match="Registered source hash does not match",
    ):
        compile_knowledge_release(
            manifest=manifest,
            source_uri_resolver=resolver,
            embedding_provider=DeterministicEmbeddingProvider(dimension=8),
            ingestion_job_id="release-ingestion-002",
        )


def test_compile_knowledge_release_rejects_a_blank_job_id() -> None:
    with pytest.raises(ValueError, match="ingestion_job_id must be non-empty"):
        compile_knowledge_release(
            manifest=load_knowledge_release_manifest(MANIFEST_PATH),
            source_uri_resolver=make_resolver(),
            embedding_provider=DeterministicEmbeddingProvider(dimension=8),
            ingestion_job_id=" ",
        )


class FakeIndexingAdapter:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def index_documents(
        self,
        *,
        config: OpenSearchIndexConfig,
        documents: list[object],
        refresh: bool,
    ) -> BulkIndexResult:
        self.calls.append(
            {
                "config": config,
                "documents": list(documents),
                "refresh": refresh,
            }
        )
        return BulkIndexResult(
            index_name=config.index_name,
            index_created=True,
            documents_indexed=len(documents),
            refresh_requested=refresh,
        )


def make_compilation():
    return compile_knowledge_release(
        manifest=load_knowledge_release_manifest(MANIFEST_PATH),
        source_uri_resolver=make_resolver(),
        embedding_provider=DeterministicEmbeddingProvider(dimension=8),
        ingestion_job_id="release-ingestion-003",
    )


def test_publish_knowledge_release_writes_the_compiled_documents() -> None:
    compilation = make_compilation()
    adapter = FakeIndexingAdapter()
    index_config = OpenSearchIndexConfig(
        index_name="cso-knowledge-acme-local-v2",
        vector_dimension=8,
        number_of_replicas=0,
    )

    publication = publish_knowledge_release(
        compilation=compilation,
        index_config=index_config,
        indexing_adapter=adapter,
    )

    assert publication.index_result.index_name == "cso-knowledge-acme-local-v2"
    assert publication.index_result.documents_indexed == len(
        compilation.index_documents
    )
    assert len(adapter.calls) == 1
    assert adapter.calls[0]["refresh"] is True


def test_publish_knowledge_release_rejects_a_vector_dimension_mismatch() -> None:
    compilation = make_compilation()

    with pytest.raises(
        ReleaseCompilationError,
        match="vector dimension must match",
    ):
        publish_knowledge_release(
            compilation=compilation,
            index_config=OpenSearchIndexConfig(
                index_name="cso-knowledge-acme-local-v2",
                vector_dimension=16,
                number_of_replicas=0,
            ),
            indexing_adapter=FakeIndexingAdapter(),
        )
