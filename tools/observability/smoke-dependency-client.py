"""Invoke actual Python dependency clients; no model, workflow or provider writes."""

import asyncio
import json
import os
import time

from agent_runtime.integrations.customer_evidence import (
    KnowledgeRagCustomerEvidenceClient,
)
from agent_runtime.integrations.order_lookup import McpOrderLookupClient
from agent_runtime.observability import telemetry_runtime


async def main():
    start = time.monotonic()
    try:
        with telemetry_runtime._tracer.start_as_current_span(
            "dependency.smoke", record_exception=False, set_status_on_exception=False
        ):
            evidence = await KnowledgeRagCustomerEvidenceClient(
                context_assertion=os.environ["SMOKE_RAG_ASSERTION"],
                base_url=os.environ["SMOKE_AGENT_URL"],
            ).retrieve_customer_evidence("CANARY_CONTENT damaged item policy")
            assert evidence.evidence == []
            order = await McpOrderLookupClient(
                context_assertion=os.environ["SMOKE_GATEWAY_ASSERTION"],
                endpoint=os.environ["SMOKE_GATEWAY_URL"] + "/mcp",
            ).lookup_order("CANARY_CONTENT")
            assert order.reference == "CANARY_CONTENT"
        print(
            json.dumps(
                {
                    "success": True,
                    "elapsed_ms": round((time.monotonic() - start) * 1000),
                    "mode": "synthetic_dependencies",
                }
            )
        )
    finally:
        telemetry_runtime.shutdown()


asyncio.run(main())
