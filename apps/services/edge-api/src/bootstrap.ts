import { initializeTelemetry } from '@cso/observability-node';
import { shutdownWithTelemetry } from './observability.js';

const telemetry = initializeTelemetry({ serviceName: 'edge-api' });

try {
  const { startServer } = await import('./server.js');
  const server = await startServer({ telemetry });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await shutdownWithTelemetry({
      closeServer: () => server.close(),
      shutdownTelemetry: () => telemetry.shutdown(),
    });
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch {
  console.error('edge.startup.failed');
  await telemetry.shutdown();
  process.exitCode = 1;
}
