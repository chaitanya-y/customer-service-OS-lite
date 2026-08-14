from fastapi import FastAPI

from .api import router as knowledge_router

app = FastAPI(title="Customer Service OS Knowledge/RAG Service")
app.include_router(knowledge_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"service": "knowledge-rag", "status": "ok"}
