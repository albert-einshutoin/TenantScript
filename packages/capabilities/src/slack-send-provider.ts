import type { CapabilityProvider } from "./index.js";

const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;

export interface SlackSendProviderOptions {
  resolveAccessToken: () => Promise<string> | string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type SlackSendProviderErrorCode =
  | "slack_send_invalid_configuration"
  | "slack_send_input_invalid"
  | "slack_send_credential_unavailable"
  | "slack_send_delivery_rejected"
  | "slack_send_delivery_ambiguous";

export class SlackSendProviderError extends Error {
  override readonly name = "SlackSendProviderError";

  constructor(readonly code: SlackSendProviderErrorCode) {
    super(code);
  }

  toJSON(): { code: SlackSendProviderErrorCode } {
    return { code: this.code };
  }
}

export function createSlackSendProvider(options: SlackSendProviderOptions): CapabilityProvider {
  if (
    !isRecord(options) ||
    Object.keys(options).some(
      (key) => key !== "resolveAccessToken" && key !== "fetcher" && key !== "timeoutMs"
    ) ||
    typeof options.resolveAccessToken !== "function" ||
    (options.fetcher !== undefined && typeof options.fetcher !== "function") ||
    (options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000))
  ) {
    throw new SlackSendProviderError("slack_send_invalid_configuration");
  }
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (input) => {
    const message = parseSlackSendInput(input);
    let accessToken: string;
    try {
      accessToken = await options.resolveAccessToken();
    } catch {
      throw new SlackSendProviderError("slack_send_credential_unavailable");
    }
    if (
      typeof accessToken !== "string" ||
      !/^[\x21-\x7e]+$/u.test(accessToken) ||
      new TextEncoder().encode(accessToken).byteLength > 7_500
    ) {
      throw new SlackSendProviderError("slack_send_credential_unavailable");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      // chat.postMessage is a side effect. Keep the destination fixed and issue exactly one
      // request because retrying an ambiguous timeout can duplicate a message Slack accepted.
      const response = await fetcher(SLACK_CHAT_POST_MESSAGE_URL, {
        method: "POST",
        redirect: "manual",
        credentials: "omit",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(message)
      });
      if (response.status !== 200 || response.redirected) throw deliveryAmbiguous();
      const value = await readBoundedJson(response);
      if (isRecord(value) && value.ok === false && typeof value.error === "string") {
        throw new SlackSendProviderError("slack_send_delivery_rejected");
      }
      return parseSlackSendSuccess(value);
    } catch (error) {
      if (error instanceof SlackSendProviderError) throw error;
      throw deliveryAmbiguous();
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    throw deliveryAmbiguous();
  }
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw deliveryAmbiguous();
  }
  const body = (response as unknown as { body: ReadableStream<Uint8Array> | null }).body;
  if (body === null) throw deliveryAmbiguous();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw deliveryAmbiguous();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    ) as unknown;
  } catch {
    throw deliveryAmbiguous();
  }
}

function parseSlackSendSuccess(value: unknown): { channel: string; timestamp: string } {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    typeof value.channel !== "string" ||
    !/^[CDG][A-Z0-9]{2,127}$/u.test(value.channel) ||
    typeof value.ts !== "string" ||
    !/^\d{1,20}\.\d{1,20}$/u.test(value.ts)
  ) {
    throw deliveryAmbiguous();
  }
  return { channel: value.channel, timestamp: value.ts };
}

function parseSlackSendInput(input: unknown): { channel: string; text: string } {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !("channel" in input) ||
    !("text" in input) ||
    typeof input.channel !== "string" ||
    !/^[CDG][A-Z0-9]{2,127}$/u.test(input.channel) ||
    typeof input.text !== "string" ||
    input.text.length === 0 ||
    new TextEncoder().encode(input.text).byteLength > 40_000
  ) {
    throw new SlackSendProviderError("slack_send_input_invalid");
  }
  return { channel: input.channel, text: input.text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deliveryAmbiguous(): SlackSendProviderError {
  return new SlackSendProviderError("slack_send_delivery_ambiguous");
}
