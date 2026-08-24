from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class KnowledgeRetrievalSettings(BaseSettings):
    """Runtime settings for the local Knowledge/RAG retrieval service."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: SecretStr

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    context_assertion_hmac_secret: SecretStr
    context_assertion_issuer: str = Field(min_length=1)
    knowledge_rag_context_assertion_audience: str = Field(
        default="knowledge-rag",
        min_length=1,
    )

    knowledge_release_id: str = Field(min_length=1)
    knowledge_index_name: str = Field(
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
        min_length=1,
    )
    knowledge_locale: str = Field(default="en-US", min_length=1)
    customer_evidence_top_k: int = Field(default=3, ge=1, le=10)
