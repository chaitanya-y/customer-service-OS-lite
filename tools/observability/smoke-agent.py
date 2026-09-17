"""Real Agent Runtime app with synthetic auth and tripwires against paid calls."""

import socket

import uvicorn
from agent_runtime.main import app
from agent_runtime.refund.router import (
    get_refund_answer_composer,
    get_refund_intent_extractor,
)


def forbid_model_dependency():
    # Missing-order-reference graph path must not invoke these methods.
    class ForbiddenModel:
        async def extract(self, *args, **kwargs):
            raise AssertionError("Model invocation is forbidden in telemetry smoke")

        async def compose(self, *args, **kwargs):
            raise AssertionError("Model invocation is forbidden in telemetry smoke")

    return ForbiddenModel()


app.dependency_overrides[get_refund_intent_extractor] = forbid_model_dependency
app.dependency_overrides[get_refund_answer_composer] = forbid_model_dependency

if __name__ == "__main__":
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        print(listener.getsockname()[1], flush=True)
        server = uvicorn.Server(
            uvicorn.Config(app, log_level="critical", access_log=False)
        )
        server.run(sockets=[listener])
