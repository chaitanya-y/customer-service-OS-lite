import type { TelemetryHandle } from '@cso/observability-node';

let telemetry: TelemetryHandle | undefined;

export function setTelemetry(handle: TelemetryHandle): void {
  telemetry = handle;
}

export function getTelemetry(): TelemetryHandle {
  if (telemetry === undefined) throw new Error('TELEMETRY_NOT_INITIALIZED');
  return telemetry;
}
