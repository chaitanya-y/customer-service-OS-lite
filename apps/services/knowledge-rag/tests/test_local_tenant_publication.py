from pathlib import Path

import pytest

from knowledge_rag.embeddings import DeterministicEmbeddingProvider
from knowledge_rag.local_tenant_publication import (
    DEFAULT_INDEX_NAME,
    LocalSourceUriResolver,
    LocalTenantPublicationError,
    compile_tenant_local_release,
    main,
    publish_tenant_local_release,
)
from knowledge_rag.opensearch_indexing import BulkIndexResult
from knowledge_rag.opensearch_schema import OpenSearchIndexConfig


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
                "documents": documents,
                "refresh": refresh,
            }
        )
        return BulkIndexResult(
            index_name=config.index_name,
            index_created=True,
            documents_indexed=len(documents),
            refresh_requested=refresh,
        )


def test_compile_tenant_local_release_scopes_all_chunks_to_tenant() -> None:
    compilation = compile_tenant_local_release(
        embedding_provider=DeterministicEmbeddingProvider(dimension=8)
    )

    assert compilation.tenant_id == "tenant-local"
    assert compilation.environment_id == "local"
    assert len(compilation.artifacts) == 3
    assert all(
        document.tenant_id == "tenant-local"
        and document.environment_id == "local"
        for document in compilation.index_documents
    )


def test_publish_tenant_local_release_uses_isolated_index() -> None:
    adapter = FakeIndexingAdapter()

    publication = publish_tenant_local_release(
        embedding_provider=DeterministicEmbeddingProvider(dimension=8),
        indexing_adapter=adapter,
    )

    assert publication.index_result.index_name == DEFAULT_INDEX_NAME
    assert publication.index_result.documents_indexed == 18
    assert len(adapter.calls) == 1
    assert adapter.calls[0]["refresh"] is True


def test_local_source_uri_resolver_rejects_unregistered_uri(
    tmp_path: Path,
) -> None:
    resolver = LocalSourceUriResolver(
        {"s3://cso-knowledge/tenant-local/approved.md": tmp_path}
    )

    with pytest.raises(
        LocalTenantPublicationError,
        match="no approved fixture mapping",
    ):
        resolver.resolve("s3://cso-knowledge/tenant-local/unapproved.md")


def test_main_requires_explicit_paid_embedding_acknowledgement() -> None:
    with pytest.raises(
        LocalTenantPublicationError,
        match="--allow-paid-embedding",
    ):
        main([])
