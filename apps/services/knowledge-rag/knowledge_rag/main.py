from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from cso_observability import TelemetryRuntime
from fastapi import FastAPI

from .api import router as knowledge_router
from .observability import telemetry_runtime as default_telemetry_runtime


def create_app(
    telemetry_runtime: TelemetryRuntime = default_telemetry_runtime,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        telemetry_runtime.shutdown()

    application = FastAPI(
        title="Customer Service OS Knowledge/RAG Service",
        lifespan=lifespan,
    )
    application.state.cso_telemetry_runtime = telemetry_runtime
    application.include_router(knowledge_router)

    @application.get("/health")
    def health() -> dict[str, str]:
        return {"service": "knowledge-rag", "status": "ok"}

    telemetry_runtime.attach_asgi(application)
    return application


app = create_app()
