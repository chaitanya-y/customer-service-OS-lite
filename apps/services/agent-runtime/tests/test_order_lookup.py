from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Self

import pytest
from mcp.types import CallToolResult, TextContent

import agent_runtime.integrations.order_lookup as order_lookup_module
from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    InvalidOrderContextError,
    McpOrderLookupClient,
    OrderLookupUnauthorizedError,
    OrderNotFoundError,
    OrderSource,
)

TEST_CONTEXT_ASSERTION = "header.claims.signature"

SAFE_ORDER_CONTEXT = {
    "schemaVersion": "1",
    "observationId": "observation-1",
    "observedAt": "2026-07-26T12:00:00.000Z",
    "source": {
        "provider": "vendure",
        "orderId": "3",
        "factsVersion": f"sha256:{'a' * 64}",
    },
    "reference": "ORDER-123",
    "status": "Delivered",
    "active": False,
    "placedAt": "2026-07-25T23:59:40.265Z",
    "customerRef": {
        "customerId": "customer-42",
    },
    "total": {
        "amountMinor": 10_000,
        "currency": "USD",
    },
    "items": [],
    "payments": [],
    "fulfillments": [],
}


def stub_mcp(
    monkeypatch: pytest.MonkeyPatch,
    *,
    result: CallToolResult | None = None,
    transport_error: Exception | None = None,
) -> list[object]:
    events: list[object] = []

    @asynccontextmanager
    async def fake_streamable_http_client(
        url: str,
        *,
        http_client: Any,
    ) -> AsyncIterator[tuple[object, object, object]]:
        events.append(
            (
                "connect",
                url,
                http_client.timeout.connect,
                http_client.headers[CONTEXT_ASSERTION_HEADER],
            )
        )

        if transport_error:
            raise transport_error

        yield object(), object(), object()

    class FakeClientSession:
        def __init__(self, _read_stream: object, _write_stream: object) -> None:
            events.append("session_created")

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(
            self,
            _exception_type: object,
            _exception: object,
            _traceback: object,
        ) -> None:
            return None

        async def initialize(self) -> None:
            events.append("initialized")

        async def call_tool(
            self,
            name: str,
            arguments: dict[str, Any],
        ) -> CallToolResult:
            events.append(("call_tool", name, arguments))
            assert result is not None
            return result

    monkeypatch.setattr(
        order_lookup_module,
        "streamable_http_client",
        fake_streamable_http_client,
    )
    monkeypatch.setattr(
        order_lookup_module,
        "ClientSession",
        FakeClientSession,
    )

    return events


@pytest.mark.asyncio
async def test_lookup_order_returns_a_typed_order_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="safe order context",
            )
        ],
        structuredContent=SAFE_ORDER_CONTEXT,
    )
    events = stub_mcp(monkeypatch, result=result)
    client = McpOrderLookupClient(
        context_assertion=TEST_CONTEXT_ASSERTION,
        timeout_seconds=5,
    )

    order = await client.lookup_order("  ORDER-123  ")

    assert order.reference == "ORDER-123"
    assert order.source == OrderSource(
        provider="vendure",
        order_id="3",
        facts_version=f"sha256:{'a' * 64}",
    )
    assert order.customer_ref is not None
    assert order.customer_ref.customer_id == "customer-42"
    assert events == [
        (
            "connect",
            "http://127.0.0.1:3002/mcp",
            5,
            TEST_CONTEXT_ASSERTION,
        ),
        "session_created",
        "initialized",
        (
            "call_tool",
            "lookup_order",
            {"orderReference": "ORDER-123"},
        ),
    ]


@pytest.mark.asyncio
async def test_lookup_order_raises_a_stable_not_found_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="Order was not found",
            )
        ],
        structuredContent={
            "error": {
                "code": "order_not_found",
                "message": "Order was not found",
            }
        },
        isError=True,
    )
    stub_mcp(monkeypatch, result=result)
    client = McpOrderLookupClient(
        context_assertion=TEST_CONTEXT_ASSERTION,
    )

    with pytest.raises(OrderNotFoundError) as captured:
        await client.lookup_order("MISSING")

    assert captured.value.code == "order_not_found"


@pytest.mark.asyncio
async def test_lookup_order_rejects_malformed_structured_content(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    malformed_context = {
        **SAFE_ORDER_CONTEXT,
        "customerRef": {
            "customerId": "customer-42",
            "email": "private@example.com",
        },
    }
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="malformed order context",
            )
        ],
        structuredContent=malformed_context,
    )
    stub_mcp(monkeypatch, result=result)
    client = McpOrderLookupClient(
        context_assertion=TEST_CONTEXT_ASSERTION,
    )

    with pytest.raises(InvalidOrderContextError) as captured:
        await client.lookup_order("ORDER-123")

    assert captured.value.code == "invalid_order_context"


@pytest.mark.asyncio
async def test_lookup_order_hides_transport_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub_mcp(
        monkeypatch,
        transport_error=OSError("private connection details"),
    )
    client = McpOrderLookupClient(
        context_assertion=TEST_CONTEXT_ASSERTION,
    )

    with pytest.raises(
        order_lookup_module.OrderLookupUnavailableError,
        match="Order lookup is unavailable",
    ) as captured:
        await client.lookup_order("ORDER-123")

    assert captured.value.code == "order_lookup_unavailable"
    assert "private connection details" not in str(captured.value)


@pytest.mark.asyncio
async def test_lookup_order_maps_context_authorization_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    result = CallToolResult(
        content=[
            TextContent(
                type="text",
                text="Trusted context is required",
            )
        ],
        structuredContent={
            "error": {
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            }
        },
        isError=True,
    )
    stub_mcp(monkeypatch, result=result)
    client = McpOrderLookupClient(
        context_assertion=TEST_CONTEXT_ASSERTION,
    )

    with pytest.raises(OrderLookupUnauthorizedError) as captured:
        await client.lookup_order("ORDER-123")

    assert captured.value.code == "context_unauthorized"


def test_order_lookup_client_rejects_a_missing_context_assertion() -> None:
    with pytest.raises(ValueError, match="context_assertion is invalid"):
        McpOrderLookupClient(context_assertion="   ")
