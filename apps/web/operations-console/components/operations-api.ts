import { getApiErrorMessage } from "./human-case";

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
  if (!response.ok) throw new Error(getApiErrorMessage(body, "Unable to load Human Operations."));
  return body;
}

export async function postConsoleData(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const responseBody = await readJson(response);
  if (!response.ok) throw new Error(getApiErrorMessage(responseBody, "The human decision could not be recorded."));
  return responseBody;
}
