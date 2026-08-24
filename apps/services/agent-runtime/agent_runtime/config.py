from langchain_openai import ChatOpenAI
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from agent_runtime.integrations.order_lookup import OrderContext
from agent_runtime.refund.answer import (
    CustomerAnswer,
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
)
from agent_runtime.refund.intent import (
    REFUND_INTENT_PROMPT_VERSION,
    LangChainRefundIntentExtractor,
    RefundIntentExtraction,
    RefundIntentExtractionError,
)
from agent_runtime.refund.proposal import RefundProposalVersions


class RefundIntentModelSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: SecretStr
    refund_intent_model: str = Field(min_length=1)


class RefundAnswerModelSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: SecretStr
    refund_answer_model: str = Field(min_length=1)
    refund_answer_model_timeout_seconds: float = Field(
        default=30.0,
        gt=0,
        le=60,
    )


class AgentRuntimeContextSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    context_assertion_hmac_secret: SecretStr
    context_assertion_issuer: str = Field(min_length=1)
    agent_runtime_context_assertion_audience: str = Field(
        default="agent-runtime",
        min_length=1,
    )


class KnowledgeRagClientSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    knowledge_rag_base_url: str = Field(
        default="http://127.0.0.1:8001",
        min_length=1,
    )
    knowledge_rag_timeout_seconds: float = Field(
        default=10.0,
        gt=0,
        le=30,
    )


class RefundProposalSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    agent_release_id: str = "agent-runtime-0.1.0"
    prompt_bundle_version: str = REFUND_INTENT_PROMPT_VERSION
    model_route_id: str = "refund-intent-openai-v1"
    knowledge_release_id: str = "refund-policy-2026-08-01"
    guardrail_version: str = "refund-proposal-guardrails-v1"
    evaluation_version: str = "evaluation-not-released"
    order_lookup_tool_version: str = "lookup-order-v1"

    def to_versions(self) -> RefundProposalVersions:
        return RefundProposalVersions.model_validate(self.model_dump())


class ConfiguredRefundIntentExtractor:
    def __init__(self) -> None:
        self._delegate: LangChainRefundIntentExtractor | None = None

    async def extract(
        self,
        *,
        customer_message: str,
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        try:
            if self._delegate is None:
                settings = RefundIntentModelSettings()
                model = ChatOpenAI(
                    model=settings.refund_intent_model,
                    api_key=settings.openai_api_key,
                    temperature=0,
                    max_retries=2,
                    timeout=15,
                )
                self._delegate = LangChainRefundIntentExtractor(model)

            return await self._delegate.extract(
                customer_message=customer_message,
                order_context=order_context,
            )
        except RefundIntentExtractionError:
            raise
        except Exception as error:
            raise RefundIntentExtractionError from error


class ConfiguredRefundAnswerComposer:
    def __init__(self) -> None:
        self._delegate: LangChainRefundAnswerComposer | None = None

    async def compose(self, **kwargs) -> CustomerAnswer:
        try:
            if self._delegate is None:
                settings = RefundAnswerModelSettings()
                model = ChatOpenAI(
                    model=settings.refund_answer_model,
                    api_key=settings.openai_api_key,
                    temperature=0,
                    max_retries=0,
                    timeout=settings.refund_answer_model_timeout_seconds,
                )
                self._delegate = LangChainRefundAnswerComposer(model)

            return await self._delegate.compose(**kwargs)
        except RefundAnswerCompositionError:
            raise
        except Exception as error:
            raise RefundAnswerCompositionError from error
