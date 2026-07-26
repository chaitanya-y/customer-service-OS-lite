from fastapi.testclient import TestClient

from agent_runtime.main import app

client = TestClient(app)


def test_refund_intake() -> None:
    response = client.post(
        "/refunds/intake",
        json={
            "customer_message": "  I want a refund.  ",
            "order_reference": "  #1001  ",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "customer_message": "I want a refund.",
        "order_reference": "#1001",
        "journey": "refund",
        "status": "order_reference_received",
    }


def test_refund_intake_rejects_empty_message() -> None:
    response = client.post(
        "/refunds/intake",
        json={"customer_message": "   "},
    )

    assert response.status_code == 422
