import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTERNAL_DEPENDENCY_GAPS,
  READINESS_TARGETS,
  checkReadiness,
} from "../check-readiness.mjs";
import { buildStartCommands, startDependencies } from "../start-dependencies.mjs";

test("builds idempotent Compose starts for repository-owned dependencies only", () => {
  const commands = buildStartCommands();

  assert.deepEqual(
    commands.map(({ command, args }) => [command, args.slice(-3)]),
    [
      ["docker", ["up", "-d", "postgres"]],
      ["docker", ["up", "-d", "lgtm"]],
    ],
  );
  assert.deepEqual(
    commands.map(({ args }) => args.filter((value) => value === "-f").length),
    [1, 1],
  );
  assert.equal(
    commands.some(({ args }) => args.some((value) => /^(down|stop|rm)$/.test(value))),
    false,
  );
  assert.deepEqual(buildStartCommands(), commands);
});

test("starts existing dependencies then checks readiness without stopping anything", async () => {
  const calls = [];

  const result = await startDependencies({
    run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    waitForReadiness: async () => ({ ready: READINESS_TARGETS.map(({ name }) => name) }),
  });

  assert.deepEqual(result.ready, ["postgres", "observability"]);
  assert.equal(calls.length, 2);
  assert.equal(
    calls.flatMap(([, args]) => args).some((value) => /^(down|stop|rm)$/.test(value)),
    false,
  );
});

test("waits for every declared repository dependency to become healthy", async () => {
  let attempt = 0;
  let sleeps = 0;

  const result = await checkReadiness({
    run: async (_command, args) => {
      const service = args.at(-1);
      const healthy = attempt > 0 || service === "postgres";
      return {
        stdout: JSON.stringify([
          {
            Service: service,
            State: "running",
            Health: healthy ? "healthy" : "starting",
          },
        ]),
        stderr: "",
        exitCode: 0,
      };
    },
    now: () => attempt * 50,
    sleep: async () => {
      sleeps += 1;
      attempt += 1;
    },
    timeoutMs: 100,
    pollIntervalMs: 50,
  });

  assert.deepEqual(result.ready, ["postgres", "observability"]);
  assert.equal(sleeps, 1);
});

test("reports a bounded readiness timeout without command output", async () => {
  let now = 0;

  await assert.rejects(
    checkReadiness({
      run: async () => ({
        stdout: "private compose output",
        stderr: "private compose error",
        exitCode: 1,
      }),
      now: () => now,
      sleep: async () => {
        now += 50;
      },
      timeoutMs: 100,
      pollIntervalMs: 50,
    }),
    (error) => {
      assert.equal(error.message, "local dependencies were not ready before 100ms");
      assert.doesNotMatch(error.message, /private|compose|error/i);
      return true;
    },
  );
});

test("makes Vendure seeding and OpenSearch publication explicit gaps", () => {
  assert.deepEqual(EXTERNAL_DEPENDENCY_GAPS, [
    "Vendure is not started or seeded by this command.",
    "OpenSearch and a published knowledge release are not started or created by this command.",
    "Temporal is not started by this command.",
  ]);
});
