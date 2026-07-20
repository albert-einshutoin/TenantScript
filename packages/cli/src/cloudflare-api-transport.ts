const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com/client/v4";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_GET_ATTEMPTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;

export type CloudflareHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CloudflareFetch {
  (input: string, init: RequestInit): Promise<Response>;
}

export interface CloudflareApiTransport {
  request: (request: {
    method: CloudflareHttpMethod;
    pathSegments: readonly string[];
    query?: Readonly<Record<string, string>>;
    body?: unknown;
  }) => Promise<unknown>;
}

export type CloudflareApiErrorCode =
  | "cloudflare_api_invalid_request"
  | "cloudflare_api_unauthorized"
  | "cloudflare_api_rate_limited"
  | "cloudflare_api_unavailable"
  | "cloudflare_api_invalid_response"
  | "cloudflare_api_request_failed";

export class CloudflareApiError extends Error {
  override readonly name = "CloudflareApiError";

  constructor(
    readonly code: CloudflareApiErrorCode,
    readonly status?: number
  ) {
    super(code);
  }

  toJSON(): { code: CloudflareApiErrorCode; status?: number } {
    return this.status === undefined
      ? { code: this.code }
      : { code: this.code, status: this.status };
  }
}

interface CloudflareTimers {
  set: (callback: () => void, milliseconds: number) => unknown;
  clear: (handle: unknown) => void;
}

export function createCloudflareApiTransport(params: {
  accountId: string;
  apiToken: string;
  fetch: CloudflareFetch;
  sleep?: (milliseconds: number) => Promise<void>;
  timers?: CloudflareTimers;
  timeoutMs?: number;
  maxGetAttempts?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  maxRetryAfterMs?: number;
}): CloudflareApiTransport {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxGetAttempts = params.maxGetAttempts ?? DEFAULT_MAX_GET_ATTEMPTS;
  const maxResponseBytes = params.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRequestBytes = params.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxRetryAfterMs = params.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  if (
    !/^[0-9a-f]{32}$/u.test(params.accountId) ||
    !isApiToken(params.apiToken) ||
    typeof params.fetch !== "function" ||
    !isBoundedInteger(timeoutMs, 1, 120_000) ||
    !isBoundedInteger(maxGetAttempts, 1, 5) ||
    !isBoundedInteger(maxResponseBytes, 1, 5_242_880) ||
    !isBoundedInteger(maxRequestBytes, 1, 5_242_880) ||
    !isBoundedInteger(maxRetryAfterMs, 0, 30_000)
  ) {
    throw new TypeError("cloudflare API configuration is invalid");
  }
  const sleep = params.sleep ?? defaultSleep;
  const timers = params.timers ?? defaultTimers;

  return {
    request: async (request) => {
      const url = buildAccountUrl(params.accountId, request.pathSegments, request.query);
      const body = serializeRequestBody(request.method, request.body, maxRequestBytes);
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      };
      // Cloudflare's resource-create endpoints do not document an idempotency key. Retrying a
      // mutation after an ambiguous failure could create an unowned duplicate, so only reads may
      // be retried at this transport boundary; adapters must reconcile mutations explicitly.
      const attempts = request.method === "GET" ? maxGetAttempts : 1;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const outcome = await performAttempt({
            fetch: params.fetch,
            url,
            init: {
              method: request.method,
              headers,
              ...(body === undefined ? {} : { body })
            },
            timeoutMs,
            timers,
            maxResponseBytes,
            maxRetryAfterMs
          });
          if (outcome.kind === "rate_limited") {
            if (attempt + 1 < attempts && outcome.retryAfterMs !== null) {
              await sleep(outcome.retryAfterMs);
              continue;
            }
            throw new CloudflareApiError("cloudflare_api_rate_limited", outcome.status);
          }
          return outcome.result;
        } catch (error) {
          if (
            error instanceof CloudflareApiError &&
            error.code === "cloudflare_api_unavailable" &&
            attempt + 1 < attempts
          ) {
            await sleep(serverBackoffMs(attempt));
            continue;
          }
          throw error;
        }
      }
      throw new CloudflareApiError("cloudflare_api_unavailable");
    }
  };
}

type AttemptOutcome =
  | { kind: "success"; result: unknown }
  | { kind: "rate_limited"; retryAfterMs: number | null; status: number };

async function performAttempt(params: {
  fetch: CloudflareFetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  timers: CloudflareTimers;
  maxResponseBytes: number;
  maxRetryAfterMs: number;
}): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const handle = params.timers.set(() => {
    controller.abort();
  }, params.timeoutMs);
  try {
    let response: Response;
    try {
      response = await params.fetch(params.url, { ...params.init, signal: controller.signal });
    } catch {
      throw new CloudflareApiError("cloudflare_api_unavailable");
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("Retry-After"),
        params.maxRetryAfterMs
      );
      await cancelBody(response);
      return { kind: "rate_limited", retryAfterMs, status: response.status };
    }
    if (response.status >= 500) {
      await cancelBody(response);
      throw new CloudflareApiError("cloudflare_api_unavailable", response.status);
    }
    if (response.status === 401 || response.status === 403) {
      await cancelBody(response);
      throw new CloudflareApiError("cloudflare_api_unauthorized", response.status);
    }
    if (!response.ok) {
      await cancelBody(response);
      throw new CloudflareApiError("cloudflare_api_request_failed", response.status);
    }
    if (response.status === 204) {
      await cancelBody(response);
      return { kind: "success", result: null };
    }

    const text = await readBoundedResponse(response, params.maxResponseBytes, controller.signal);
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
    }
    if (!isRecord(envelope) || envelope.success !== true || !("result" in envelope)) {
      throw new CloudflareApiError(
        isRecord(envelope) && envelope.success === false
          ? "cloudflare_api_request_failed"
          : "cloudflare_api_invalid_response",
        response.status
      );
    }
    // Return only the documented result boundary. Provider errors/messages may contain account or
    // credential context and must never cross into setup diagnostics or journals.
    return { kind: "success", result: envelope.result };
  } finally {
    params.timers.clear(handle);
  }
}

function buildAccountUrl(
  accountId: string,
  pathSegments: readonly string[],
  query: Readonly<Record<string, string>> | undefined
): string {
  if (pathSegments.length === 0 || pathSegments.length > 16 || !pathSegments.every(isPathSegment)) {
    throw invalidRequest();
  }
  const url = new URL(
    `${CLOUDFLARE_API_ORIGIN}/accounts/${accountId}/${pathSegments.map(encodeURIComponent).join("/")}`
  );
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) ||
        typeof value !== "string" ||
        value.length > 512 ||
        hasControlCharacters(value)
      ) {
        throw invalidRequest();
      }
      url.searchParams.append(key, value);
    }
  }
  return url.toString();
}

function serializeRequestBody(
  method: CloudflareHttpMethod,
  value: unknown,
  maxRequestBytes: number
): string | undefined {
  if (value === undefined) return undefined;
  if (method === "GET") throw invalidRequest();
  try {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body, "utf8") > maxRequestBytes) {
      throw invalidRequest();
    }
    return body;
  } catch (error) {
    if (error instanceof CloudflareApiError) throw error;
    throw invalidRequest();
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await cancelBody(response);
      throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
    }
  }
  if (response.body === null) {
    throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reading = true;
  try {
    while (reading) {
      const result = await reader.read();
      if (result.done) {
        reading = false;
        continue;
      }
      const chunk = result.value;
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof CloudflareApiError) throw error;
    if (signal.aborted) throw new CloudflareApiError("cloudflare_api_unavailable");
    throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudflareApiError("cloudflare_api_invalid_response", response.status);
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseRetryAfter(value: string | null, maxMilliseconds: number): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const milliseconds = Number(value) * 1_000;
  return Number.isSafeInteger(milliseconds) && milliseconds <= maxMilliseconds
    ? milliseconds
    : null;
}

function serverBackoffMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

function isPathSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(value);
}

function isApiToken(value: string): boolean {
  return value.length >= 8 && value.length <= 512 && !/\s/u.test(value) && !/^Bearer/iu.test(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(): CloudflareApiError {
  return new CloudflareApiError("cloudflare_api_invalid_request");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const defaultTimers: CloudflareTimers = {
  set: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
};
