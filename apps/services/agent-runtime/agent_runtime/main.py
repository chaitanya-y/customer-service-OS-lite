from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from cso_observability import TelemetryRuntime
from fastapi import FastAPI

from agent_runtime.observability import telemetry_runtime as default_telemetry_runtime
from agent_runtime.refund.router import router as refund_router


def create_app(
    telemetry_runtime: TelemetryRuntime = default_telemetry_runtime,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        telemetry_runtime.shutdown()

    application = FastAPI(
        title="Customer Service OS Agent Runtime",
        version="0.1.0",
        lifespan=lifespan,
    )
    application.include_router(refund_router)

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {
            "status": "ok",
            "service": "agent-runtime",
        }

    telemetry_runtime.attach_asgi(application)
    return application


app = create_app()
