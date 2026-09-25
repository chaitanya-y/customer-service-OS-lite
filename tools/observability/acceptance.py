"""Safely validate the local observability alert contract.

``--check`` performs an offline contract check. ``--run`` additionally uses the
repository-pinned Grafana image to run Prometheus rule tests and emits the
existing synthetic cross-service telemetry smoke. Neither mode calls a model,
commerce provider, database, or refund API.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
ALERTS_PATH = ROOT / "infrastructure/observability/grafana/alerts.yaml"
COMPOSE_PATH = ROOT / "infrastructure/observability/compose.yaml"
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


@dataclass(frozen=True)
class AlertRule:
    """The Prometheus-owned part of one provisioned Grafana alert."""

    uid: str
    title: str
    query: str
    hold_for: str


def load_grafana_rules(path: Path = ALERTS_PATH) -> list[AlertRule]:
    """Load only each alert's real PromQL query, never Grafana expressions."""

    document = json.loads(path.read_text(encoding="utf-8"))
    rules: list[AlertRule] = []
    for group in document.get("groups", []):
        for raw_rule in group.get("rules", []):
            query = next(
                (
                    data.get("model", {}).get("expr")
                    for data in raw_rule.get("data", [])
                    if data.get("refId") == "A"
                ),
                None,
            )
            if not isinstance(query, str) or not query.strip():
                raise ValueError(f"{raw_rule.get('uid', '<unknown>')} has no PromQL A query")
            rules.append(
                AlertRule(
                    uid=raw_rule["uid"],
                    title=raw_rule["title"],
                    query=query,
                    hold_for=raw_rule["for"],
                )
            )
    return rules


def _alert_name(uid: str) -> str:
    return "CsoAcceptance_" + uid.replace("-", "_")


def build_prometheus_rule_document(rules: list[AlertRule]) -> dict[str, Any]:
    """Translate Grafana provisioning into a promtool-compatible rule group."""

    return {
        "groups": [
            {
                "name": "cso-observability-acceptance",
                "interval": "1m",
                "rules": [
                    {
                        "alert": _alert_name(rule.uid),
                        "expr": rule.query,
                        "for": rule.hold_for,
                    }
                    for rule in rules
                ],
            }
        ]
    }


def _series(series: str, values: str) -> dict[str, str]:
    return {"series": series, "values": values}


def _scenario(uid: str) -> tuple[list[dict[str, str]], str, str, str, dict[str, str]]:
    """Return synthetic inputs and evaluation times for one alert."""

    scenarios: dict[
        str, tuple[list[dict[str, str]], str, str, str, dict[str, str]]
    ] = {
        "cso-model-safety-rate": (
            [
                _series(
                    'cso_operation_completed_total{service_name="agent-runtime",operation="model.refund_answer",outcome="success"}',
                    "0+1x70",
                ),
                _series(
                    'cso_operation_completed_total{service_name="agent-runtime",operation="model.refund_answer",outcome="model_error"}',
                    "0+1x30 30x40",
                ),
            ],
            "5m",
            "25m",
            "46m",
            {},
        ),
        "cso-rag-server-error-rate": (
            [
                _series(
                    'cso_operation_completed_total{service_name="knowledge-rag",operation="rag.vector_search",outcome="success"}',
                    "0+2x80",
                ),
                _series(
                    'cso_operation_completed_total{service_name="knowledge-rag",operation="rag.vector_search",outcome="server_error"}',
                    "0+1x35 35x45",
                ),
            ],
            "5m",
            "25m",
            "56m",
            {},
        ),
        "cso-refund-fallback-event-rate": (
            [
                _series(
                    'cso_operation_completed_total{service_name="agent-runtime",operation="model.refund_answer",outcome="success"}',
                    "0+1x90",
                ),
                _series(
                    'cso_operation_completed_total{service_name="agent-runtime",operation="answer.fallback",outcome="fallback"}',
                    "0+1x35 35x55",
                ),
            ],
            "5m",
            "25m",
            "66m",
            {},
        ),
        "cso-platform-server-error-rate": (
            [
                _series(
                    'cso_operation_completed_total{service_name="edge-api",operation="request",outcome="success"}',
                    "0+4x70",
                ),
                _series(
                    'cso_operation_completed_total{service_name="edge-api",operation="request",outcome="server_error"}',
                    "0+1x35 35x35",
                ),
            ],
            "5m",
            "25m",
            "51m",
            {"service_name": "edge-api"},
        ),
        "cso-stale-reconciliation": (
            [
                _series(
                    'cso_refund_executions_oldest_age_seconds{service_name="integration-gateway",outcome="PENDING_RECONCILIATION"}',
                    "0 901x20 0x20",
                )
            ],
            "0m",
            "12m",
            "22m",
            {},
        ),
        "cso-stale-provider-outbox": (
            [
                _series(
                    'cso_refund_provider_events_oldest_age_seconds{service_name="integration-gateway"}',
                    "0 301x20 0x20",
                )
            ],
            "0m",
            "12m",
            "22m",
            {},
        ),
        "cso-stale-human-outbox": (
            [
                _series(
                    'cso_human_operations_decision_outbox_oldest_age_seconds{service_name="human-operations"}',
                    "0 301x20 0x20",
                )
            ],
            "0m",
            "12m",
            "22m",
            {},
        ),
        "cso-collector-export-failure": (
            [_series("otelcol_exporter_send_failed_spans_total", "0 1x20 1x20")],
            "0m",
            "12m",
            "18m",
            {},
        ),
        "cso-collector-telemetry-missing": (
            [_series("otelcol_process_uptime_seconds_total", "1x10 _x25 1x20")],
            "5m",
            "27m",
            "36m",
            {},
        ),
        "cso-gateway-telemetry-missing": (
            [
                _series(
                    'cso_telemetry_heartbeat{service_name="integration-gateway"}',
                    "1x10 _x25 1x20",
                )
            ],
            "5m",
            "27m",
            "36m",
            {"service_name": "integration-gateway"},
        ),
        "cso-worker-telemetry-missing": (
            [
                _series(
                    'cso_telemetry_heartbeat{service_name="workflow-workers"}',
                    "1x10 _x25 1x20",
                )
            ],
            "5m",
            "27m",
            "36m",
            {"service_name": "workflow-workers"},
        ),
    }
    try:
        return scenarios[uid]
    except KeyError as exc:
        raise ValueError(f"No safe acceptance scenario exists for {uid}") from exc


def build_promtool_test_document(
    rules: list[AlertRule], rule_file: str
) -> dict[str, Any]:
    """Build independent healthy, firing and recovery checks for every alert."""

    tests: list[dict[str, Any]] = []
    for rule in rules:
        inputs, healthy_at, firing_at, recovered_at, result_labels = _scenario(
            rule.uid
        )
        expected = [
            {
                "exp_labels": result_labels,
                "exp_annotations": {},
            }
        ]
        tests.append(
            {
                "name": rule.uid,
                "interval": "1m",
                "input_series": inputs,
                "alert_rule_test": [
                    {
                        "phase": "healthy",
                        "eval_time": healthy_at,
                        "alertname": _alert_name(rule.uid),
                        "exp_alerts": [],
                    },
                    {
                        "phase": "firing",
                        "eval_time": firing_at,
                        "alertname": _alert_name(rule.uid),
                        "exp_alerts": expected,
                    },
                    {
                        "phase": "recovered",
                        "eval_time": recovered_at,
                        "alertname": _alert_name(rule.uid),
                        "exp_alerts": [],
                    },
                ],
            }
        )
    return {
        "rule_files": [rule_file],
        "evaluation_interval": "1m",
        "tests": tests,
    }


def _promtool_document(document: dict[str, Any]) -> dict[str, Any]:
    """Remove reporting-only labels before strict promtool deserialization."""

    cleaned = {**document, "tests": []}
    for case in document["tests"]:
        cleaned_case = {key: value for key, value in case.items() if key != "name"}
        cleaned_case["alert_rule_test"] = [
            {key: value for key, value in assertion.items() if key != "phase"}
            for assertion in case["alert_rule_test"]
        ]
        cleaned["tests"].append(cleaned_case)
    return cleaned


def load_pinned_observability_image(path: Path = COMPOSE_PATH) -> str:
    """Read the immutable local observability image from Compose."""

    match = re.search(r"^\s*image:\s*([^\s#]+)", path.read_text(), re.MULTILINE)
    if not match or "@sha256:" not in match.group(1):
        raise ValueError("Observability image must be pinned by sha256 digest")
    return match.group(1)


def build_promtool_command(image: str, fixture_directory: Path) -> list[str]:
    """Build a disposable, offline and read-only promtool invocation."""

    return [
        "docker",
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "-v",
        f"{fixture_directory.resolve()}:/work:ro",
        "--entrypoint",
        "/otel-lgtm/prometheus/promtool",
        image,
        "test",
        "rules",
        "/work/tests.json",
    ]


def _validate_contract(rules: list[AlertRule], tests: dict[str, Any]) -> None:
    rule_ids = {rule.uid for rule in rules}
    if rule_ids != EXPECTED_RULE_IDS:
        missing = sorted(EXPECTED_RULE_IDS - rule_ids)
        unexpected = sorted(rule_ids - EXPECTED_RULE_IDS)
        raise ValueError(f"Alert contract changed; missing={missing}, unexpected={unexpected}")
    if any(rule.hold_for != "10m" for rule in rules):
        raise ValueError("Every local acceptance alert must retain its 10m hold")
    if len(tests["tests"]) != len(rules):
        raise ValueError("Every alert must have an independent acceptance scenario")


def _report(mode: str, rules: list[AlertRule], **extra: Any) -> dict[str, Any]:
    return {
        "success": True,
        "mode": mode,
        "alert_rules": len(rules),
        "scenarios": len(rules),
        "phase_assertions": len(rules) * 3,
        "safe_synthetic_only": True,
        "external_side_effects": False,
        **extra,
    }


def run_acceptance(rules: list[AlertRule], tests: dict[str, Any]) -> dict[str, Any]:
    """Run isolated promtool scenarios, then the existing safe telemetry smoke."""

    image = load_pinned_observability_image()
    with tempfile.TemporaryDirectory(prefix="cso-observability-acceptance-") as temp:
        fixture_directory = Path(temp)
        (fixture_directory / "rules.json").write_text(
            json.dumps(build_prometheus_rule_document(rules)), encoding="utf-8"
        )
        (fixture_directory / "tests.json").write_text(
            json.dumps(_promtool_document(tests)), encoding="utf-8"
        )
        promtool = subprocess.run(
            build_promtool_command(image, fixture_directory),
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if promtool.returncode != 0:
            raise RuntimeError(
                "promtool acceptance failed:\n" + (promtool.stdout + promtool.stderr)[-8000:]
            )

    smoke_python = ROOT / "apps/services/agent-runtime/.venv/bin/python"
    if not smoke_python.exists():
        raise RuntimeError("Agent Runtime virtual environment is required for --run")
    smoke = subprocess.run(
        [
            str(smoke_python),
            str(ROOT / "tools/observability/smoke.py"),
            "--dependencies",
            "--grafana",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    if smoke.returncode != 0:
        raise RuntimeError("synthetic telemetry smoke failed:\n" + smoke.stderr[-4000:])
    smoke_report = json.loads(smoke.stdout)
    return _report(
        "run",
        rules,
        promtool_passed=True,
        telemetry_smoke=smoke_report,
        local_synthetic_telemetry_written=True,
        business_side_effects=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Validate contracts offline")
    mode.add_argument(
        "--run",
        action="store_true",
        help="Run isolated promtool tests and the safe synthetic telemetry smoke",
    )
    args = parser.parse_args()

    rules = load_grafana_rules()
    tests = build_promtool_test_document(rules, "rules.json")
    _validate_contract(rules, tests)
    report = _report("check", rules) if args.check else run_acceptance(rules, tests)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
