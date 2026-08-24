import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";

import type { RefundWorkflowActivities } from "./refund-workflow-activities.js";

type RefundWorkerOptions = Readonly<{
  taskQueue: string;
  activities: RefundWorkflowActivities;
  temporalAddress?: string;
}>;

/** Starts a worker host after its Gateway-backed activities are composed. */
export async function runRefundWorker({
  taskQueue,
  activities,
  temporalAddress,
}: RefundWorkerOptions): Promise<void> {
  const worker = await Worker.create({
    workflowsPath: fileURLToPath(new URL("./refund-workflow.ts", import.meta.url)),
    activities,
    taskQueue,
    ...(temporalAddress === undefined ? {} : { connectionOptions: { address: temporalAddress } }),
  });

  await worker.run();
}
