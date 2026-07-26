from agent_runtime.refund.graph import refund_graph


def test_refund_graph_records_order_reference() -> None:
    result = refund_graph.invoke(
        {
            "customer_message": "  I want a refund.  ",
            "order_reference": "  #1001  ",
        }
    )

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": "#1001",
        "journey": "refund",
        "status": "order_reference_received",
    }


def test_refund_graph_requests_missing_order_reference() -> None:
    result = refund_graph.invoke(
        {"customer_message": "I want a refund."}
    )

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": None,
        "journey": "refund",
        "status": "awaiting_order_reference",
    }