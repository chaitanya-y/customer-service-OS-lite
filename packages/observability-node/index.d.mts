import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export type RequestResult = {
  statusCode?: number;
  errorCategory?: 'application_error' | 'transport_error' | 'timeout';
};

export type ClientRequestResult = {
  status: number;
  telemetryError?: 'application_error';
};

export type RequestSpan = { end(result: RequestResult): void };

export type ActivityObservation<T> = {
  operation: string;
  dependency?: string;
  outcome?: (value: T) => string | undefined;
};

export type ActivityInstrumentation = {
  withActivity<T>(
    input: ActivityObservation<T>,
    activity: () => Promise<T>,
  ): Promise<T>;
};

export type RequestInstrumentation = {
  readonly enabled: boolean;
  startServerRequest(
    input: { operation: string; method: string; traceparent?: string },
    continueRequest: () => void,
  ): RequestSpan;
  withClientRequest<T extends ClientRequestResult>(
    input: { operation: string; method: string; propagate?: boolean },
    headers: HeadersInit | undefined,
    request: (headers: Headers) => Promise<T>,
  ): Promise<T>;
};

export type TelemetryHandle = RequestInstrumentation & ActivityInstrumentation & {
  shutdown(): Promise<void>;
};

export type TelemetryOptions = {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  enabled?: boolean;
  endpoint?: string;
  shutdownTimeoutMilliseconds?: number;
  diagnostic?: (message: 'telemetry.unavailable') => void;
  spanProcessor?: SpanProcessor;
  metricReader?: IMetricReader;
  logRecordProcessor?: LogRecordProcessor;
};

export function initializeTelemetry(options: TelemetryOptions): TelemetryHandle;
