from __future__ import annotations

import argparse
import os
from collections.abc import Mapping, Sequence
from pathlib import Path

from dotenv import load_dotenv

from .embeddings import EmbeddingProvider, OpenAIEmbeddingProvider
from .opensearch_indexing import OpenSearchIndexingAdapter
from .opensearch_local import create_local_opensearch_client
from .opensearch_schema import OpenSearchIndexConfig
from .release_ingestion import (
    KnowledgeReleaseCompilation,
    KnowledgeReleasePublication,
    compile_knowledge_release,
    publish_knowledge_release,
)
from .source_registry import (
    KnowledgeReleaseManifest,
    load_knowledge_release_manifest,
)

TENANT_ID = "tenant-local"
ENVIRONMENT_ID = "local"
DEFAULT_INDEX_NAME = "cso-knowledge-tenant-local-local-v1"
DEFAULT_INGESTION_JOB_ID = "tenant-local-refund-policy-publication-v1"

PROJECT_PATH = Path(__file__).resolve().parents[1]
DEPLOYABLES_PATH = PROJECT_PATH.parent
TENANT_LOCAL_MANIFEST_PATH = (
    PROJECT_PATH
    / "fixtures"
    / "source-registrations"
    / TENANT_ID
    / "refund-knowledge-release-v1.json"
)


class LocalTenantPublicationError(RuntimeError):
    """Raised when local tenant publication cannot proceed safely."""


class LocalSourceUriResolver:
    """Maps only registered local-development source URIs to fixture files."""

    def __init__(self, paths_by_uri: Mapping[str, Path]) -> None:
        self._paths_by_uri = dict(paths_by_uri)

    def resolve(self, source_uri: str) -> Path:
        try:
            source_path = self._paths_by_uri[source_uri]
        except KeyError as error:
            raise LocalTenantPublicationError(
                "The local publisher has no approved fixture mapping for "
                f"source URI: {source_uri}"
            ) from error

        if not source_path.is_file():
            raise LocalTenantPublicationError(
                f"Registered fixture source does not exist: {source_path}"
            )

        return source_path


def load_tenant_local_manifest() -> KnowledgeReleaseManifest:
    manifest = load_knowledge_release_manifest(TENANT_LOCAL_MANIFEST_PATH)

    if (
        manifest.tenant_id != TENANT_ID
        or manifest.environment_id != ENVIRONMENT_ID
    ):
        raise LocalTenantPublicationError(
            "The local publisher only permits the tenant-local/local release."
        )

    return manifest


def build_tenant_local_source_uri_resolver() -> LocalSourceUriResolver:
    return LocalSourceUriResolver(
        {
            (
                "s3://cso-knowledge/tenant-local/"
                "refund-policy-2026-08-01.md"
            ): (
                DEPLOYABLES_PATH
                / "control-knowledge"
                / "fixtures"
                / "source-documents"
                / "acme"
                / "refund-policy-2026-08-01.md"
            ),
            (
                "s3://cso-knowledge/tenant-local/"
                "internal-refund-escalation-playbook.md"
            ): (
                PROJECT_PATH
                / "fixtures"
                / "source-documents"
                / "acme"
                / "internal-refund-escalation-playbook.md"
            ),
            (
                "s3://cso-knowledge/tenant-local/"
                "refund-policy-2026-07-01.md"
            ): (
                PROJECT_PATH
                / "fixtures"
                / "source-documents"
                / "acme"
                / "refund-policy-superseded-2026-07-01.md"
            ),
        }
    )


def compile_tenant_local_release(
    *,
    embedding_provider: EmbeddingProvider,
    ingestion_job_id: str = DEFAULT_INGESTION_JOB_ID,
) -> KnowledgeReleaseCompilation:
    return compile_knowledge_release(
        manifest=load_tenant_local_manifest(),
        source_uri_resolver=build_tenant_local_source_uri_resolver(),
        embedding_provider=embedding_provider,
        ingestion_job_id=ingestion_job_id,
    )


def publish_tenant_local_release(
    *,
    embedding_provider: EmbeddingProvider,
    indexing_adapter: OpenSearchIndexingAdapter,
    index_name: str = DEFAULT_INDEX_NAME,
    ingestion_job_id: str = DEFAULT_INGESTION_JOB_ID,
) -> KnowledgeReleasePublication:
    compilation = compile_tenant_local_release(
        embedding_provider=embedding_provider,
        ingestion_job_id=ingestion_job_id,
    )

    return publish_knowledge_release(
        compilation=compilation,
        index_config=OpenSearchIndexConfig(
            index_name=index_name,
            vector_dimension=embedding_provider.model.dimension,
            number_of_replicas=0,
        ),
        indexing_adapter=indexing_adapter,
    )


def parse_args(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Publish the approved tenant-local knowledge release."
    )
    parser.add_argument(
        "--allow-paid-embedding",
        action="store_true",
        help="Required acknowledgement before OpenAI embedding calls are made.",
    )
    parser.add_argument(
        "--index-name",
        default=DEFAULT_INDEX_NAME,
        help="Name for a new or schema-compatible local OpenSearch index.",
    )
    parser.add_argument(
        "--ingestion-job-id",
        default=DEFAULT_INGESTION_JOB_ID,
        help="Traceable identifier recorded on every indexed chunk.",
    )
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> None:
    arguments = parse_args(arguments)

    if not arguments.allow_paid_embedding:
        raise LocalTenantPublicationError(
            "Refusing to call OpenAI without --allow-paid-embedding."
        )

    load_dotenv(PROJECT_PATH / ".env")
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise LocalTenantPublicationError(
            "OPENAI_API_KEY is required to publish this embedding-backed release."
        )

    publication = publish_tenant_local_release(
        embedding_provider=OpenAIEmbeddingProvider(api_key=api_key),
        indexing_adapter=OpenSearchIndexingAdapter(
            create_local_opensearch_client()
        ),
        index_name=arguments.index_name,
        ingestion_job_id=arguments.ingestion_job_id,
    )

    print(
        "Published "
        f"{publication.index_result.documents_indexed} chunks to "
        f"{publication.index_result.index_name}."
    )


if __name__ == "__main__":
    main()
