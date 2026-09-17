import { initializeTelemetry } from '@cso/observability-node';

const telemetry = initializeTelemetry({ serviceName: 'integration-gateway' });

try {
  const { startServer } = await import('./server.js');
  const server = await startServer({ telemetry });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
    } finally {
      await telemetry.shutdown();
    }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
} catch {
  console.error('integration-gateway.startup.failed');
  await telemetry.shutdown();
  process.exitCode = 1;
}
