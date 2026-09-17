import type { RequestInstrumentation, RequestSpan } from '@cso/observability-node';
import type { FastifyInstance, FastifyRequest } from 'fastify';

function routeOperation(request: FastifyRequest): string {
  const route = request.routeOptions.url;
  return route === undefined ? 'unmatched' : `${request.method} ${route}`;
}

export function instrumentHttpServer(
  app: FastifyInstance,
  telemetry: RequestInstrumentation | undefined,
): void {
  if (!telemetry?.enabled) return;

  const requests = new WeakMap<FastifyRequest, RequestSpan>();
  const failed = new WeakSet<FastifyRequest>();

  app.addHook('onRequest', (request, _reply, done) => {
    const requestSpan = telemetry.startServerRequest(
      { operation: routeOperation(request), method: request.method },
      done,
    );
    requests.set(request, requestSpan);
  });
  app.addHook('onError', (request, _reply, _error, done) => {
    failed.add(request);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    requests.get(request)?.end({
      statusCode: reply.statusCode,
      ...(failed.has(request) ? { errorCategory: 'application_error' } : {}),
    });
    done();
  });
}

export async function runWithin(
  action: () => void | Promise<void>,
  timeoutMilliseconds: number,
  onTimeout?: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* teardown remains best effort */ }
          resolve();
        }, timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closeFastifyWithin(
  app: FastifyInstance,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  await runWithin(
    () => app.close(),
    timeoutMilliseconds,
    () => app.server.closeAllConnections?.(),
  );
}
