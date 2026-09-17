import type { RequestInstrumentation, RequestSpan } from '@cso/observability-node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
  const completed = new WeakSet<FastifyRequest>();
  const complete = (
    request: FastifyRequest,
    reply: FastifyReply,
    prematureClose = false,
  ): void => {
    if (completed.has(request)) return;
    completed.add(request);
    requests.get(request)?.end({
      ...(prematureClose ? {} : { statusCode: reply.raw.statusCode || reply.statusCode }),
      ...(prematureClose
        ? { errorCategory: 'transport_error' as const }
        : failed.has(request)
          ? { errorCategory: 'application_error' as const }
          : {}),
    });
  };

  app.addHook('onRequest', (request, reply, done) => {
    const traceparent = request.headers.traceparent;
    const requestSpan = telemetry.startServerRequest(
      {
        operation: routeOperation(request),
        method: request.method,
        ...(typeof traceparent === 'string' ? { traceparent } : {}),
      },
      done,
    );
    requests.set(request, requestSpan);
    reply.raw.once('finish', () => complete(request, reply));
    reply.raw.once('close', () => complete(request, reply, !reply.raw.writableFinished));
  });
  app.addHook('onError', (request, _reply, _error, done) => {
    failed.add(request);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    complete(request, reply);
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
