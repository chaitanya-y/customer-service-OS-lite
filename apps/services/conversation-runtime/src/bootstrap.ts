import { initializeTelemetry } from '@cso/observability-node';

import { setTelemetry } from './telemetry-state.js';

const telemetry = initializeTelemetry({ serviceName: 'conversation-runtime' });
setTelemetry(telemetry);

try {
  await import('./server.js');
} catch {
  console.error('conversation-runtime.startup.failed');
  await telemetry.shutdown();
  process.exitCode = 1;
}
