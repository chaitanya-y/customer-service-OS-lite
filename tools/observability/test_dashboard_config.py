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
    "cso_refund_executions_current",
    "cso_refund_executions_oldest_age_seconds",
    "cso_refund_provider_events_pending",
    "cso_refund_provider_events_oldest_age_seconds",
    "cso_human_operations_decision_outbox_pending",
    "cso_human_operations_decision_outbox_oldest_age_seconds",
    "cso_telemetry_heartbeat",
    "otelcol_exporter_enqueue_failed_log_records_total",
    "otelcol_exporter_enqueue_failed_metric_points_total",
    "otelcol_exporter_enqueue_failed_spans_total",
    "otelcol_exporter_send_failed_log_records_total",
    "otelcol_exporter_send_failed_metric_points_total",
    "otelcol_exporter_send_failed_spans_total",
    "otelcol_process_uptime_seconds_total",
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
        self.assertIn("authoritative", text)
        self.assertIn("trace-only", text)
        self.assertIn("not distinct refunds", text)

        for title in (
            "Authoritative refund executions",
            "Refund and provider backlog age",
            "Pending durable outbox records",
            "Service telemetry heartbeat",
            "Collector export failures",
        ):
            self.assertIn(title, panels)

        collector_failures = panels["Collector export failures"]
        self.assertIn("or vector(0)", collector_failures["targets"][0]["expr"])

        health = panels.get("Telemetry health limits")
        self.assertIsNotNone(health)
        assert health is not None
        health_text = health["options"]["content"].lower()
        self.assertIn("heartbeat", health_text)
        self.assertIn("collector", health_text)
        self.assertNotIn("no absence alert", health_text)

    def test_promql_uses_only_emitted_safe_metrics_and_labels(self) -> None:
        dashboard = json.loads(DASHBOARD_PATH.read_text(encoding="utf-8"))
        expressions = prometheus_expressions(dashboard)
        self.assertGreaterEqual(len(expressions), 12)

        for expression in expressions:
            metric_names = set(re.findall(r"\b(cso_[a-z0-9_]+)\b", expression))
            metric_names.update(re.findall(r"\b(otelcol_[a-z0-9_]+)\b", expression))
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
        self.assertTrue(any("cso_refund_executions_current" in expression for expression in expressions))
        self.assertTrue(any("cso_telemetry_heartbeat" in expression for expression in expressions))
        self.assertTrue(any("otelcol_exporter_send_failed" in expression for expression in expressions))

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
                "Pending reconciliation is stale",
                "Provider refund-event delivery is stale",
                "Human decision delivery is stale",
                "Collector export is failing",
                "Collector telemetry disappeared",
                "Integration Gateway telemetry disappeared",
                "Workflow Worker telemetry disappeared",
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
            self.assertEqual(
                rule["condition"],
                "C",
                f'{rule["title"]} must evaluate the reduced threshold expression',
            )
            self.assertEqual(
                rule["noDataState"],
                "OK",
                "local comparison queries return no series when their condition is healthy",
            )
            self.assertRegex(rule["for"], r"^(?:[1-9][0-9]*)m$")
            self.assertGreaterEqual(int(rule["for"][:-1]), 10)
            self.assertTrue(
                set(rule["labels"]) <= {"severity", "owner", "scope", "signal"}
            )
            for value in rule["labels"].values():
                self.assertRegex(value, r"^[a-z][a-z0-9_-]{0,31}$")
            self.assertEqual(rule["labels"]["scope"], "local")
            self.assertIn(rule["labels"]["severity"], {"warning", "critical"})
            prometheus_query = next(
                item for item in rule["data"] if item["refId"] == "A"
            )
            self.assertIs(
                prometheus_query["model"].get("instant"),
                True,
                f'{rule["title"]} must return an instant vector to the threshold',
            )
            self.assertIs(
                prometheus_query["model"].get("range"),
                False,
                f'{rule["title"]} must not pass a range series to the threshold',
            )
            reduce_expression = next(
                item for item in rule["data"] if item["refId"] == "B"
            )
            self.assertEqual(reduce_expression["datasourceUid"], "__expr__")
            self.assertEqual(reduce_expression["model"].get("type"), "reduce")
            self.assertEqual(reduce_expression["model"].get("expression"), "A")
            self.assertEqual(reduce_expression["model"].get("reducer"), "last")

            threshold_expression = next(
                item for item in rule["data"] if item["refId"] == "C"
            )
            self.assertEqual(threshold_expression["datasourceUid"], "__expr__")
            self.assertEqual(threshold_expression["model"].get("type"), "threshold")
            self.assertEqual(threshold_expression["model"].get("expression"), "B")
            self.assertEqual(
                threshold_expression["model"]["conditions"][0]["query"]["params"],
                ["C"],
            )
            query = prometheus_query["model"]["expr"]
            if rule["labels"]["signal"] in {"operation_outcome", "operation_event"}:
                self.assertIn("increase(cso_operation_completed_total", query)
                self.assertRegex(query, r">=\s*(?:20|30|50)")
            metric_names = set(re.findall(r"\b(cso_[a-z0-9_]+)\b", query))
            metric_names.update(re.findall(r"\b(otelcol_[a-z0-9_]+)\b", query))
            self.assertTrue(metric_names <= EMITTED_METRICS, query)
            for label in FORBIDDEN_QUERY_LABELS:
                self.assertNotRegex(query, rf"\b{label}\s*=")

        refund_rule = next(rule for rule in rules if rule["title"] == "Refund-path fallback event rate")
        self.assertEqual(refund_rule["labels"]["signal"], "operation_event")
        self.assertIn("not a refund count", refund_rule["annotations"]["summary"].lower())
        self.assertFalse(any("temporal" in rule["title"].lower() for rule in rules))

        missing_rules = [rule for rule in rules if rule["labels"]["signal"] == "telemetry_missing"]
        self.assertEqual(len(missing_rules), 3)
        for rule in missing_rules:
            query = next(item["model"]["expr"] for item in rule["data"] if item["refId"] == "A")
            self.assertIn("offset 5m", query)
            if rule["title"] == "Collector telemetry disappeared":
                self.assertIn(
                    "absent_over_time(otelcol_process_uptime_seconds_total", query
                )
                self.assertIn(
                    "max_over_time(otelcol_process_uptime_seconds_total", query
                )
            else:
                self.assertIn("absent_over_time(cso_telemetry_heartbeat", query)
                self.assertIn("max_over_time(cso_telemetry_heartbeat", query)

        collector_failure_rule = next(
            rule for rule in rules if rule["title"] == "Collector export is failing"
        )
        collector_failure_query = next(
            item["model"]["expr"]
            for item in collector_failure_rule["data"]
            if item["refId"] == "A"
        )
        self.assertIn("or vector(0)", collector_failure_query)

    def test_compose_provisions_dashboard_and_local_alerts(self) -> None:
        compose = COMPOSE_PATH.read_text(encoding="utf-8")
        self.assertIn("./grafana/foundation.json:/otel-lgtm/cso-dashboards/foundation.json:ro", compose)
        self.assertIn(
            "./grafana/alerts.yaml:/otel-lgtm/grafana/conf/provisioning/alerting/cso-alerts.yaml:ro",
            compose,
        )

    def test_collector_exports_its_bounded_internal_metrics_locally(self) -> None:
        collector = (ROOT / "infrastructure/observability/collector.yaml").read_text(
            encoding="utf-8"
        )
        self.assertIn("telemetry:", collector)
        self.assertIn("level: basic", collector)
        self.assertIn("readers:", collector)
        self.assertIn("periodic:", collector)
        self.assertIn("protocol: http/protobuf", collector)
        self.assertIn(
            "endpoint: http://127.0.0.1:9090/api/v1/otlp/v1/metrics",
            collector,
            "the internal OTLP exporter forwards an explicit path unchanged",
        )


if __name__ == "__main__":
    unittest.main()
