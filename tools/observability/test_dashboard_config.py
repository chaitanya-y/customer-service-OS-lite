"""Static safety checks for the local Grafana dashboard and alert provisioning."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DASHBOARD_PATH = ROOT / "infrastructure/observability/grafana/foundation.json"
ALERTS_PATH = ROOT / "infrastructure/observability/grafana/alerts.yaml"
COMPOSE_PATH = ROOT / "infrastructure/observability/compose.yaml"

EMITTED_METRICS = {
    "cso_operation_completed_total",
    "cso_operation_duration_seconds_bucket",
    "cso_model_tokens_total",
}
FORBIDDEN_QUERY_LABELS = {
    "customer_id",
    "order_id",
    "refund_id",
    "workflow_id",
    "tenant_id",
    "trace_id",
    "span_id",
    "message",
    "prompt",
    "body",
}


def load_json_yaml(path: Path) -> dict[str, Any]:
    """Read JSON, which is also a valid YAML subset used for dependency-free tests."""

    return json.loads(path.read_text(encoding="utf-8"))


def prometheus_expressions(dashboard: dict[str, Any]) -> list[str]:
    expressions: list[str] = []
    for panel in dashboard["panels"]:
        datasource = panel.get("datasource", {})
        if datasource.get("type") != "prometheus":
            continue
        expressions.extend(
            target["expr"]
            for target in panel.get("targets", [])
            if isinstance(target.get("expr"), str)
        )
    return expressions


class DashboardConfigTests(unittest.TestCase):
    def test_dashboard_has_the_required_local_views(self) -> None:
        dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
        panels = {panel["title"]: panel for panel in dashboard["panels"]}

        self.assertTrue(
            {
                "Platform observability",
                "Model and RAG",
                "Refund operations",
                "Telemetry health",
            }.issubset(panels),
            "dashboard must expose platform, model/RAG, refund, and telemetry-health views",
        )
        temporal = panels.get("Temporal activity traces (trace-only)")
        self.assertIsNotNone(temporal, "Temporal activities need a Tempo trace-query panel")
        assert temporal is not None
        self.assertEqual(temporal["datasource"], {"type": "tempo", "uid": "tempo"})
        target = temporal["targets"][0]
        self.assertEqual(target["queryType"], "traceql")
        self.assertIn('resource.service.name = "workflow-workers"', target["expr"])
        self.assertIn("span.operation =~", target["expr"])

        coverage = panels.get("Refund operations coverage")
        self.assertIsNotNone(coverage)
        assert coverage is not None
        text = coverage["options"]["content"].lower()
        self.assertIn("trace-only", text)
        self.assertIn("not distinct refunds", text)

        health = panels.get("Telemetry health limits")
        self.assertIsNotNone(health)
        assert health is not None
        self.assertIn("no absence alert", health["options"]["content"].lower())

    def test_promql_uses_only_emitted_safe_metrics_and_labels(self) -> None:
        dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
        expressions = prometheus_expressions(dashboard)
        self.assertGreaterEqual(len(expressions), 7)

        for expression in expressions:
            metric_names = set(re.findall(r"\b(cso_[a-z0-9_]+)\b", expression))
            self.assertTrue(metric_names, expression)
            self.assertTrue(metric_names <= EMITTED_METRICS, expression)
            self.assertNotIn('operation=~".*"', expression)
            for label in FORBIDDEN_QUERY_LABELS:
                self.assertNotRegex(expression, rf"\b{label}\s*=")
        self.assertTrue(
            any("cso_model_tokens_total" in expression for expression in expressions),
            "model/RAG view must use the emitted model token counter",
        )
        self.assertTrue(
            any('operation=~"rag[.].*"' in expression for expression in expressions),
            "model/RAG view must retain bounded RAG operation filtering",
        )

    def test_alert_rules_are_local_non_notifying_and_have_minimum_traffic(self) -> None:
        self.assertTrue(ALERTS_PATH.is_file(), "missing local Grafana alert provisioning")
        if not ALERTS_PATH.is_file():
            return
        alerts = load_json_yaml(ALERTS_PATH)
        rules = [rule for group in alerts["groups"] for rule in group["rules"]]
        titles = {rule["title"] for rule in rules}
        self.assertTrue(
            {
                "Model guard or failure event rate",
                "RAG server error rate",
                "Refund-path fallback event rate",
                "Platform server error rate",
            }.issubset(titles)
        )

        serialized = json.dumps(alerts).lower()
        for forbidden in (
            "contactpoints",
            "notification",
            "receivers",
            "webhook",
            "slack",
            "pagerduty",
            "http://",
            "https://",
        ):
            self.assertNotIn(forbidden, serialized)

        for rule in rules:
            self.assertRegex(rule["for"], r"^(?:[1-9][0-9]*)m$")
            self.assertGreaterEqual(int(rule["for"][:-1]), 10)
            self.assertTrue(
                set(rule["labels"]) <= {"severity", "owner", "scope", "signal"}
            )
            for value in rule["labels"].values():
                self.assertRegex(value, r"^[a-z][a-z0-9_-]{0,31}$")
            self.assertEqual(rule["labels"]["scope"], "local")
            self.assertIn(rule["labels"]["severity"], {"warning", "critical"})
            query = next(item["model"]["expr"] for item in rule["data"] if item["refId"] == "A")
            self.assertIn("increase(cso_operation_completed_total", query)
            self.assertRegex(query, r">=\s*(?:20|30|50)")
            metric_names = set(re.findall(r"\b(cso_[a-z0-9_]+)\b", query))
            self.assertTrue(metric_names <= EMITTED_METRICS, query)
            self.assertNotIn("absent(", query)
            for label in FORBIDDEN_QUERY_LABELS:
                self.assertNotRegex(query, rf"\b{label}\s*=")

        refund_rule = next(rule for rule in rules if rule["title"] == "Refund-path fallback event rate")
        self.assertEqual(refund_rule["labels"]["signal"], "operation_event")
        self.assertIn("not a refund count", refund_rule["annotations"]["summary"].lower())
        self.assertFalse(any("temporal" in rule["title"].lower() for rule in rules))

    def test_compose_provisions_dashboard_and_local_alerts(self) -> None:
        compose = COMPOSE_PATH.read_text(encoding="utf-8")
        self.assertIn("./grafana/foundation.json:/otel-lgtm/cso-dashboards/foundation.json:ro", compose)
        self.assertIn(
            "./grafana/alerts.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/cso-alerts.yaml:ro",
            compose,
        )


if __name__ == "__main__":
    unittest.main()
