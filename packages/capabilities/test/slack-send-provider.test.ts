import { describe, expect, it, vi } from "vitest";
import * as capabilities from "../src/index.js";
import type { CapabilityProvider } from "../src/index.js";

interface SlackSendProviderFactory {
  (options: {
    resolveAccessToken: () => Promise<string>;
    fetcher?: typeof fetch;
  }): CapabilityProvider;
}

describe("production Slack send provider", () => {
  it("resolves a server-owned token and posts one closed message to Slack", async () => {
    const accessToken = "xoxb-synthetic-production-token";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        channel: "C12345678",
        ts: "1712345678.123456",
        message: {
          user: "U12345678",
          type: "message",
          ts: "1712345678.123456",
          bot_id: "B12345678",
          app_id: "A12345678",
          text: "Deployment completed",
          team: "T12345678"
        },
        response_metadata: { warnings: [] }
      })
    );
    const factory: unknown = Reflect.get(capabilities, "createSlackSendProvider");

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") throw new Error("production Slack provider is unavailable");
    const provider = (factory as SlackSendProviderFactory)({
      resolveAccessToken: () => Promise.resolve(accessToken),
      fetcher
    });

    await expect(
      provider({ channel: "C12345678", text: "Deployment completed" })
    ).resolves.toEqual({ channel: "C12345678", timestamp: "1712345678.123456" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(init?.body).toBe(
      JSON.stringify({ channel: "C12345678", text: "Deployment completed" })
    );
  });
});
