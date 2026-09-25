"""Behavior tests for the safe observability acceptance runner."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from tools.observability.acceptance import (
    build_prometheus_rule_document,
    build_promtool_command,
    build_promtool_test_document,
    load_grafana_rules,
    load_pinned_observability_image,
)

ROOT = Path(__file__).resolve().parents[2]
ALERTS_PATH = ROOT / "infrastructure/observability/grafana/alerts.yaml"
COMPOSE_PATH = ROOT / "infrastructure/observability/compose.yaml"
RUNNER_PATH = ROOT / "tools/observability/acceptance.py"

EXPECTED_RULE_IDS = {
    "cso-model-safety-rate",
    "cso-rag-server-error-rate",
    "cso-refund-fallback-event-rate",
    "cso-platform-server-error-rate",
    "cso-stale-reconciliation",
    "cso-stale-provider-outbox",
    "cso-stale-human-outbox",
    "cso-collector-export-failure",
    "cso-collector-telemetry-missing",
    "cso-gateway-telemetry-missing",
    "cso-worker-telemetry-missing",
}


class ObservabilityAcceptanceTests(unittest.TestCase):
    def test_loads_every_provisioned_alert_query_without_grafana_expressions(self) -> None:
        rules = load_grafana_rules(ALERTS_PATH)

        self.assertEqual({rule.uid for rule in rules}, EXPECTED_RULE_IDS)
        self.assertTrue(all(rule.query for rule in rules))
        self.assertTrue(all(rule.hold_for == "10m" for rule in rules))

        prometheus = build_prometheus_rule_document(rules)
        generated_rules = prometheus["groups"][0]["rules"]
        self.assertEqual(len(generated_rules), 11)
        self.assertEqual(
            {rule["expr"] for rule in generated_rules},
            {rule.query for rule in rules},
            "the real PromQL must be evaluated instead of a rewritten approximation",
        )

    def test_every_alert_has_independent_healthy_firing_and_recovery_assertions(self) -> None:
        rules = load_grafana_rules(ALERTS_PATH)

        document = build_promtool_test_document(rules, "rules.json")

        self.assertEqual(document["rule_files"], ["rules.json"])
        self.assertEqual(len(document["tests"]), 11)
        self.assertEqual(
            {case["name"] for case in document["tests"]}, EXPECTED_RULE_IDS
        )
        for case in document["tests"]:
            assertions = case["alert_rule_test"]
            self.assertEqual(
                [assertion["phase"] for assertion in assertions],
                ["healthy", "firing", "recovered"],
                case["name"],
            )
            self.assertEqual(assertions[0]["exp_alerts"], [], case["name"])
            self.assertEqual(len(assertions[1]["exp_alerts"]), 1, case["name"])
            self.assertEqual(assertions[2]["exp_alerts"], [], case["name"])
            self.assertTrue(case["input_series"], case["name"])

        serialized = json.dumps(document).lower()
        for forbidden in (
            "customer_id",
            "order_id",
            "refund_id",
            "workflow_id",
            "tenant_id",
            "trace_id",
            "authorization",
            "api_key",
            "prompt",
            "customer message",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_promtool_runs_in_the_pinned_image_without_network_or_writable_mounts(self) -> None:
        image = load_pinned_observability_image(COMPOSE_PATH)
        fixture_directory = Path("/tmp/cso-observability-acceptance")

        command = build_promtool_command(image, fixture_directory)

        self.assertIn("@sha256:", image)
        self.assertEqual(command[:3], ["docker", "run", "--rm"])
        self.assertIn("--pull=never", command)
        self.assertIn("--network=none", command)
        self.assertIn("--read-only", command)
        self.assertIn(
            f"{fixture_directory.resolve()}:/work:ro", command
        )
        self.assertEqual(
            command[-4:],
            [image, "test", "rules", "/work/tests.json"],
        )

    def test_check_mode_reports_complete_contract_without_running_docker(self) -> None:
        result = subprocess.run(
            [sys.executable, str(RUNNER_PATH), "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(
            report,
            {
                "success": True,
                "mode": "check",
                "alert_rules": 11,
                "scenarios": 11,
                "phase_assertions": 33,
                "safe_synthetic_only": True,
                "external_side_effects": False,
            },
        )


if __name__ == "__main__":
    unittest.main()
