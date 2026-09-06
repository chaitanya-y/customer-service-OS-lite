import { getApiErrorMessage } from "./human-case";

export class OperationsApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, body: unknown, fallback: string) {
    super(getApiErrorMessage(body, fallback));
    this.status = status;
    const record = body && typeof body === "object" ? body as Record<string, unknown> : undefined;
    const error = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : undefined;
    this.code = typeof error?.code === "string" ? error.code : undefined;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export async function getConsoleData(path: string): Promise<unknown> {
  const response = await fetch(path, { cache: "no-store" });
  const body = await readJson(response);
  if (!response.ok) throw new OperationsApiError(response.status, body, "Unable to load Human Operations.");
  return body;
}

export async function postConsoleData(path: string, body: unknown, idempotencyKey = crypto.randomUUID()): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  const responseBody = await readJson(response);
  if (!response.ok) throw new OperationsApiError(response.status, responseBody, "The human decision could not be recorded.");
  return responseBody;
}
