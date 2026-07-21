import type { CapabilityProvider } from "./index.js";

const SLACK_CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

export interface SlackSendProviderOptions {
  resolveAccessToken: () => Promise<string> | string;
  fetcher?: typeof fetch;
}

export function createSlackSendProvider(options: SlackSendProviderOptions): CapabilityProvider {
  const fetcher = options.fetcher ?? fetch;
  return async (input) => {
    const message = input as { channel: string; text: string };
    const accessToken = await options.resolveAccessToken();
    const response = await fetcher(SLACK_CHAT_POST_MESSAGE_URL, {
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(message)
    });
    const result = (await response.json()) as { channel: string; ts: string };
    return { channel: result.channel, timestamp: result.ts };
  };
}
