import { initializeTelemetry } from '@cso/observability-node';

import { setTelemetry } from './telemetry-state.js';

const telemetry = initializeTelemetry({ serviceName: 'human-operations' });
setTelemetry(telemetry);

try {
  await import('./server.js');
} catch {
  console.error('human-operations.startup.failed');
  await telemetry.shutdown();
  process.exitCode = 1;
}
