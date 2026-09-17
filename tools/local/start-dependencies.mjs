import {
  EXTERNAL_DEPENDENCY_GAPS,
  READINESS_TARGETS,
  checkReadiness,
  runCommand,
} from "./check-readiness.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function buildStartCommands(targets = READINESS_TARGETS) {
  return targets.map(({ composeFile, service }) => ({
    command: "docker",
    args: ["compose", "-f", composeFile, "up", "-d", service],
  }));
}

export async function startDependencies({
  run = runCommand,
  waitForReadiness = checkReadiness,
  targets = READINESS_TARGETS,
} = {}) {
  for (const { command, args } of buildStartCommands(targets)) {
    const result = await run(command, args);
    if (result.exitCode !== 0) {
      throw new Error("could not start local dependencies");
    }
  }
  return waitForReadiness({ run, targets });
}

if (isDirectExecution(import.meta.url)) {
  try {
    const { ready } = await startDependencies();
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
