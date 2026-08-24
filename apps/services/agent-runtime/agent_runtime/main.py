from fastapi import FastAPI

from agent_runtime.refund.router import router as refund_router

app = FastAPI(
    title="Customer Service OS Agent Runtime",
    version="0.1.0",
)

app.include_router(refund_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "agent-runtime",
    }
