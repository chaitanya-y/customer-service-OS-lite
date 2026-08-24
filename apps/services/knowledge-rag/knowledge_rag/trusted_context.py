from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal, Protocol

import jwt
from jwt import InvalidTokenError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER = "x-cso-knowledge-context-assertion"


class KnowledgeRagContextAssertionError(ValueError):
    """Raised when a Knowledge/RAG context assertion cannot be trusted."""


class ContextTenant(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    tenant_id: str = Field(alias="tenantId", min_length=1, max_length=160)
    environment_id: str = Field(
        alias="environmentId",
        min_length=1,
        max_length=160,
    )


class ContextActor(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    kind: Literal["end_customer"]
    principal_id: str = Field(alias="principalId", min_length=1, max_length=160)


class ContextSubject(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    customer_id: str = Field(alias="customerId", min_length=1, max_length=160)


class ContextDelegation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["self"]


class ContextRoute(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    home_region: str = Field(alias="homeRegion", min_length=1, max_length=160)
    home_cell: str = Field(alias="homeCell", min_length=1, max_length=160)
    routing_epoch: int = Field(alias="routingEpoch", ge=1)


class ContextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    request_id: str = Field(alias="requestId", min_length=1, max_length=160)
    trace_id: str = Field(alias="traceId", min_length=1, max_length=160)
    channel_id: str = Field(alias="channelId", min_length=1, max_length=160)


class ContextAssertionClaims(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    context_version: Literal["1"] = Field(alias="contextVersion")
    context_id: str = Field(alias="contextId", min_length=1, max_length=160)
    tenant: ContextTenant
    actor: ContextActor
    subject: ContextSubject
    delegation: ContextDelegation
    purpose: Literal["customer_support"]
    route: ContextRoute
    request: ContextRequest
    iss: str = Field(min_length=1, max_length=200)
    aud: str = Field(min_length=1, max_length=200)
    iat: int = Field(ge=0)
    exp: int = Field(gt=0)

    @model_validator(mode="after")
    def validate_self_service_binding(self) -> ContextAssertionClaims:
        if self.actor.principal_id != self.subject.customer_id:
            raise ValueError(
                "Self-service principal must match the subject customer"
            )

        return self


class VerifiedKnowledgeRagContext(BaseModel):
    """Minimal trusted context allowed to scope RAG retrieval."""

    model_config = ConfigDict(frozen=True)

    context_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    subject_customer_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    trace_id: str = Field(min_length=1)
    routing_epoch: int = Field(ge=1)


class KnowledgeRagContextVerifier(Protocol):
    def verify(self, assertion: str | None) -> VerifiedKnowledgeRagContext:
        """Verify an assertion intended specifically for Knowledge/RAG."""


class HmacKnowledgeRagContextVerifier:
    def __init__(
        self,
        *,
        secret: str,
        expected_issuer: str,
        expected_audience: str,
        expected_tenant_id: str,
        expected_environment_id: str,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        if len(secret.encode("utf-8")) < 32:
            raise ValueError(
                "Context assertion secret must contain at least 32 bytes"
            )

        self._secret = secret
        self._expected_issuer = expected_issuer
        self._expected_audience = expected_audience
        self._expected_tenant_id = expected_tenant_id
        self._expected_environment_id = expected_environment_id
        self._now = now or (lambda: datetime.now(UTC))

    def verify(self, assertion: str | None) -> VerifiedKnowledgeRagContext:
        try:
            if not assertion or len(assertion) > 8_192:
                raise KnowledgeRagContextAssertionError()

            header = jwt.get_unverified_header(assertion)
            if (
                header.get("alg") != "HS256"
                or header.get("typ") != "cso-context+jwt"
            ):
                raise KnowledgeRagContextAssertionError()

            payload = jwt.decode(
                assertion,
                self._secret,
                algorithms=["HS256"],
                issuer=self._expected_issuer,
                audience=self._expected_audience,
                options={
                    "require": ["exp", "iat", "iss", "aud"],
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )
            claims = ContextAssertionClaims.model_validate(payload)
            now_seconds = int(self._now().timestamp())

            if (
                claims.tenant.tenant_id != self._expected_tenant_id
                or claims.tenant.environment_id
                != self._expected_environment_id
                or claims.iat > now_seconds + 30
                or claims.exp <= now_seconds
                or claims.exp <= claims.iat
                or claims.exp - claims.iat > 300
            ):
                raise KnowledgeRagContextAssertionError()

            return VerifiedKnowledgeRagContext(
                context_id=claims.context_id,
                tenant_id=claims.tenant.tenant_id,
                environment_id=claims.tenant.environment_id,
                subject_customer_id=claims.subject.customer_id,
                request_id=claims.request.request_id,
                trace_id=claims.request.trace_id,
                routing_epoch=claims.route.routing_epoch,
            )
        except KnowledgeRagContextAssertionError:
            raise
        except (InvalidTokenError, ValidationError, ValueError, TypeError) as error:
            raise KnowledgeRagContextAssertionError() from error
