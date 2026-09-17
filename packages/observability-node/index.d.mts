import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { IMetricReader } from '@opentelemetry/sdk-metrics';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export type RequestResult = {
  statusCode: number;
  errorCategory?: 'application_error' | 'transport_error' | 'timeout';
};

export type RequestSpan = { end(result: RequestResult): void };

export type RequestInstrumentation = {
  readonly enabled: boolean;
  startServerRequest(
    input: { operation: string; method: string },
    continueRequest: () => void,
  ): RequestSpan;
  withClientRequest<T extends { status: number }>(
    input: { operation: string; method: string },
    headers: HeadersInit | undefined,
    request: (headers: Headers) => Promise<T>,
  ): Promise<T>;
};

export type TelemetryHandle = RequestInstrumentation & {
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
