import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const READINESS_TARGETS = Object.freeze([
  {
    name: "postgres",
    composeFile: `${REPOSITORY_ROOT}infrastructure/local/compose.yaml`,
    service: "postgres",
  },
  {
    name: "observability",
    composeFile: `${REPOSITORY_ROOT}infrastructure/observability/compose.yaml`,
    service: "lgtm",
  },
]);

export const EXTERNAL_DEPENDENCY_GAPS = Object.freeze([
  "Vendure is not started or seeded by this command.",
  "OpenSearch and a published knowledge release are not started or created by this command.",
  "Temporal is not started by this command.",
]);

export function readinessCommand(target) {
  return {
    command: "docker",
    args: [
      "compose",
      "-f",
      target.composeFile,
      "ps",
      "--format",
      "json",
      target.service,
    ],
  };
}

export async function checkReadiness({
  run = runCommand,
  now = Date.now,
  sleep = delay,
  timeoutMs = 60_000,
  pollIntervalMs = 1_000,
  targets = READINESS_TARGETS,
} = {}) {
  const startedAt = now();

  while (true) {
    const ready = [];
    for (const target of targets) {
      const { command, args } = readinessCommand(target);
      const result = await run(command, args);
      if (isHealthy(result, target.service)) {
        ready.push(target.name);
      }
    }

    if (ready.length === targets.length) {
      return { ready };
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`local dependencies were not ready before ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

function isHealthy(result, service) {
  if (result.exitCode !== 0) {
    return false;
  }
  try {
    const entries = JSON.parse(result.stdout);
    const entry = Array.isArray(entries)
      ? entries.find(({ Service }) => Service === service)
      : entries;
    return entry?.State === "running" && entry?.Health === "healthy";
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 1 }));
  });
}

if (isDirectExecution(import.meta.url)) {
  try {
    const { ready } = await checkReadiness();
    console.log(`Local dependencies ready: ${ready.join(", ")}`);
    for (const gap of EXTERNAL_DEPENDENCY_GAPS) {
      console.log(`Gap: ${gap}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function isDirectExecution(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}
