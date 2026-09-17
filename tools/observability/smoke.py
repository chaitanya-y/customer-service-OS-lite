"""Offline cross-language telemetry proof; optional forwarding to local Grafana.

Run with Agent Runtime's Python. Uses ephemeral ports, synthetic signing keys,
the real missing-order-reference graph path and zero paid/provider calls.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import (
    ExportLogsServiceRequest,
)
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import (
    ExportMetricsServiceRequest,
)
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

ROOT = Path(__file__).resolve().parents[2]
MESSAGES = {
    "/v1/traces": ExportTraceServiceRequest,
    "/v1/metrics": ExportMetricsServiceRequest,
    "/v1/logs": ExportLogsServiceRequest,
}


def hex_id(value: str) -> str:
    if len(value) in (16, 32) and all(c in "0123456789abcdef" for c in value):
        return value
    return base64.b64decode(value).hex()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--grafana",
        action="store_true",
        help="Forward synthetic signals only to 127.0.0.1:4318",
    )
    args = parser.parse_args()
    records: dict[str, list[dict]] = {path: [] for path in MESSAGES}
    errors: list[str] = []

    class Collector(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if self.path not in MESSAGES:
                self.send_error(404)
                return
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                chunks = []
                while True:
                    size = int(self.rfile.readline().split(b";", 1)[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    assert sum(map(len, chunks)) + size <= 2_000_000
                    chunks.append(self.rfile.read(size))
                    self.rfile.read(2)
                payload = b"".join(chunks)
            else:
                payload = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                payload = gzip.decompress(payload)
            content_type = self.headers.get("Content-Type", "")
            if "json" in content_type:
                document = json.loads(payload)
            else:
                message = MESSAGES[self.path]()
                message.ParseFromString(payload)
                document = MessageToDict(message)
            encoded = json.dumps(document)
            if (
                "CANARY_CONTENT" in encoded
                or "synthetic-context-key" in encoded
                or "eyJ" in encoded
            ):
                errors.append("Sensitive canary detected before export")
                self.send_error(400)
                return
            records[self.path].append(document)
            if args.grafana:
                try:
                    with urlopen(
                        Request(
                            "http://127.0.0.1:4318" + self.path,
                            data=payload,
                            headers={"Content-Type": content_type},
                        ),
                        timeout=3,
                    ):
                        pass
                except HTTPError as exc:
                    errors.append(
                        f"Collector {exc.code}: {exc.read(500).decode(errors='replace')}"
                    )
                except OSError as exc:
                    errors.append(type(exc).__name__)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(b"{}" if "json" in content_type else b"")

    with (
        ThreadingHTTPServer(("127.0.0.1", 0), Collector) as collector,
        tempfile.TemporaryDirectory(prefix="cso-otel-smoke-") as isolated,
    ):
        thread = threading.Thread(target=collector.serve_forever, daemon=True)
        thread.start()
        # Deliberately do not inherit provider credentials or tracing configuration.
        environment = {
            "PATH": os.environ.get("PATH", ""),
            "PYTHONPATH": str(ROOT / "apps/services/agent-runtime"),
            "CSO_TELEMETRY_ENABLED": "true",
            "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{collector.server_port}",
            "TENANT_ID": "smoke-tenant",
            "ENVIRONMENT_ID": "local",
            "CONTEXT_ASSERTION_HMAC_SECRET": "synthetic-context-key-not-for-real-use-00",
            "CONTEXT_ASSERTION_ISSUER": "smoke-edge",
            "AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE": "agent-runtime",
            "LANGSMITH_TRACING": "false",
            "LANGCHAIN_TRACING_V2": "false",
        }
        agent = subprocess.Popen(
            [sys.executable, str(ROOT / "tools/observability/smoke-agent.py")],
            cwd=isolated,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            import selectors

            with selectors.DefaultSelector() as selector:
                selector.register(agent.stdout, selectors.EVENT_READ)
                assert selector.select(20), "Agent smoke startup timed out"
                port_line = agent.stdout.readline().strip()
                assert port_line, agent.stderr.read()[-2000:]
                port = int(port_line)
            agent_url = f"http://127.0.0.1:{port}"
            deadline = time.monotonic() + 10
            while True:
                try:
                    with urlopen(agent_url + "/health", timeout=1):
                        break
                except OSError:
                    assert time.monotonic() < deadline, "Agent smoke not ready"
                    time.sleep(0.1)
            environment["SMOKE_AGENT_URL"] = agent_url
            node = shutil.which("node")
            assert node, "Node 24 must be on PATH"
            result = subprocess.run(
                [
                    node,
                    "--import",
                    "tsx",
                    str(ROOT / "tools/observability/smoke-edge.mts"),
                ],
                cwd=ROOT / "apps/services/edge-api",
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            assert result.returncode == 0, result.stderr[-1500:]
            node_result = json.loads(result.stdout.strip().splitlines()[-1])
        finally:
            agent.terminate()
            try:
                agent.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                agent.kill()
                agent.communicate(timeout=2)
            collector.shutdown()
        assert not errors, errors
        spans = []
        for document in records["/v1/traces"]:
            for resource in document.get("resourceSpans", []):
                service = next(
                    a["value"]["stringValue"]
                    for a in resource["resource"]["attributes"]
                    if a["key"] == "service.name"
                )
                for scope in resource.get("scopeSpans", []):
                    spans.extend((service, span) for span in scope.get("spans", []))
        by_trace: dict[str, list[tuple[str, dict]]] = {}
        for service, span in spans:
            by_trace.setdefault(hex_id(span["traceId"]), []).append((service, span))
        linked = [
            (trace_id, group)
            for trace_id, group in by_trace.items()
            if {service for service, _ in group} == {"edge-api", "agent-runtime"}
        ]
        assert len(linked) == 1, "Expected one cross-language trace"
        trace_id, group = linked[0]
        assert trace_id != "11111111111111111111111111111111", (
            "Public trace identity was trusted"
        )
        ids = {hex_id(span["spanId"]) for _, span in group}
        python_span = next(
            span for service, span in group if service == "agent-runtime"
        )
        assert hex_id(python_span["parentSpanId"]) in ids, (
            "Python span is not linked to Edge client"
        )
        for path, key in (
            ("/v1/logs", "resourceLogs"),
            ("/v1/metrics", "resourceMetrics"),
        ):
            services = {
                a["value"]["stringValue"]
                for doc in records[path]
                for resource in doc.get(key, [])
                for a in resource["resource"]["attributes"]
                if a["key"] == "service.name"
            }
            assert services == {"edge-api", "agent-runtime"}, (
                f"Missing signals for {path}: {services}"
            )
        print(
            json.dumps(
                {
                    **node_result,
                    "trace_id": trace_id,
                    "linked_spans": len(group),
                    "signals": ["traces", "metrics", "logs"],
                    "canaries_absent": True,
                    "grafana_forwarded": args.grafana,
                },
                indent=2,
            )
        )


if __name__ == "__main__":
    main()
