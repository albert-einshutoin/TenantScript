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
  it.each([
    ["missing options", undefined],
    ["missing resolver", {}],
    ["non-function resolver", { resolveAccessToken: "xoxb-config-secret" }],
    [
      "non-function fetcher",
      { resolveAccessToken: () => Promise.resolve("xoxb-config-secret"), fetcher: "fetch" }
    ],
    [
      "zero timeout",
      { resolveAccessToken: () => Promise.resolve("xoxb-config-secret"), timeoutMs: 0 }
    ],
    [
      "excessive timeout",
      { resolveAccessToken: () => Promise.resolve("xoxb-config-secret"), timeoutMs: 60_001 }
    ],
    [
      "unknown option",
      { resolveAccessToken: () => Promise.resolve("xoxb-config-secret"), endpoint: "evil" }
    ]
  ])("fails closed for %s", (_label, options) => {
    expect(() => capabilities.createSlackSendProvider(options as never)).toThrow(
      expect.objectContaining({ code: "slack_send_invalid_configuration" })
    );
  });

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

    await expect(provider({ channel: "C12345678", text: "Deployment completed" })).resolves.toEqual(
      { channel: "C12345678", timestamp: "1712345678.123456" }
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit" });
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(init?.body).toBe(JSON.stringify({ channel: "C12345678", text: "Deployment completed" }));
  });

  it.each([
    ["unknown field", { channel: "C12345678", text: "hello", workspaceId: "T_UNTRUSTED" }],
    ["invalid channel", { channel: "https://evil.example", text: "hello" }],
    ["empty text", { channel: "C12345678", text: "" }],
    ["oversized text", { channel: "C12345678", text: "あ".repeat(13_334) }]
  ])("rejects %s before credential or provider access", async (_label, input) => {
    const resolveAccessToken = vi.fn().mockResolvedValue("xoxb-input-secret");
    const fetcher = vi.fn<typeof fetch>();
    const provider = capabilities.createSlackSendProvider({ resolveAccessToken, fetcher });

    await expect(provider(input)).rejects.toMatchObject({ code: "slack_send_input_invalid" });
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redacts resolver failures and does not access Slack", async () => {
    const resolverSecret = "resolver-failure-secret";
    const fetcher = vi.fn<typeof fetch>();
    const provider = capabilities.createSlackSendProvider({
      resolveAccessToken: () => Promise.reject(new Error(resolverSecret)),
      fetcher
    });

    const failure = await captureFailure(
      provider({ channel: "C12345678", text: "Deployment completed" })
    );

    expect(failure).toMatchObject({ code: "slack_send_credential_unavailable" });
    expect(JSON.stringify(failure)).not.toContain(resolverSecret);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["", "token with whitespace", "x".repeat(7_501)])(
    "rejects invalid resolved credential before Slack access",
    async (accessToken) => {
      const fetcher = vi.fn<typeof fetch>();
      const provider = capabilities.createSlackSendProvider({
        resolveAccessToken: () => Promise.resolve(accessToken),
        fetcher
      });

      await expect(
        provider({ channel: "C12345678", text: "Deployment completed" })
      ).rejects.toMatchObject({ code: "slack_send_credential_unavailable" });
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "explicit provider rejection",
      () => Response.json({ ok: false, error: "channel_not_found-provider-secret" }),
      "slack_send_delivery_rejected"
    ],
    [
      "HTTP failure",
      () => new Response("provider-secret", { status: 503 }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "rate limit",
      () => new Response("provider-secret", { status: 429 }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "wrong content type",
      () => new Response("provider-secret", { status: 200 }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "malformed JSON",
      () =>
        new Response("{provider-secret", {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "malformed success",
      () => Response.json({ ok: true, channel: "provider-secret" }),
      "slack_send_delivery_ambiguous"
    ],
    [
      "oversized response",
      () =>
        new Response(`{"ok":true,"padding":"${"x".repeat(65_536)}provider-secret"}`, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      "slack_send_delivery_ambiguous"
    ]
  ])("fails closed without retrying on %s", async (_label, response, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const provider = capabilities.createSlackSendProvider({
      resolveAccessToken: () => Promise.resolve("xoxb-transport-secret"),
      fetcher
    });

    const failure = await captureFailure(
      provider({ channel: "C12345678", text: "Deployment completed" })
    );

    expect(failure).toMatchObject({ code });
    expect(JSON.stringify(failure)).not.toContain("provider-secret");
    expect(JSON.stringify(failure)).not.toContain("transport-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous connection loss", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network-provider-secret"));
    const provider = capabilities.createSlackSendProvider({
      resolveAccessToken: () => Promise.resolve("xoxb-transport-secret"),
      fetcher
    });

    await expect(
      provider({ channel: "C12345678", text: "Deployment completed" })
    ).rejects.toMatchObject({ code: "slack_send_delivery_ambiguous" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled Slack request once and reports an ambiguous delivery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("timeout-provider-secret", "AbortError"));
        });
      });
    });
    const provider = capabilities.createSlackSendProvider({
      resolveAccessToken: () => Promise.resolve("xoxb-timeout-secret"),
      fetcher,
      timeoutMs: 10
    });

    const failure = await captureFailure(
      provider({ channel: "C12345678", text: "Deployment completed" })
    );

    expect(failure).toMatchObject({ code: "slack_send_delivery_ambiguous" });
    expect(JSON.stringify(failure)).not.toContain("timeout-secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps provider rejection details and credentials out of broker errors and audits", async () => {
    const accessToken = "xoxb-broker-secret";
    const audits: unknown[] = [];
    const broker = capabilities.createCapabilityBroker({
      grants: { "slack.send": { channel: "C12345678" } },
      providers: {
        "slack.send": capabilities.createSlackSendProvider({
          resolveAccessToken: () => Promise.resolve(accessToken),
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ ok: false, error: "channel_not_found-secret" }))
        })
      },
      auditSink: {
        writeCapabilityAudit: (record) => {
          audits.push(record);
        }
      }
    });

    const failure = await captureFailure(
      broker.call("slack.send", { channel: "C12345678", text: "Deployment completed" })
    );

    expect(failure).toBeInstanceOf(capabilities.CapabilityProviderError);
    expect(audits).toEqual([
      expect.objectContaining({
        capability: "slack.send",
        status: "error",
        reason: "provider_failed"
      })
    ]);
    expect(JSON.stringify({ failure, audits })).not.toContain(accessToken);
    expect(JSON.stringify({ failure, audits })).not.toContain("channel_not_found-secret");
  });
});

async function captureFailure(value: unknown): Promise<unknown> {
  try {
    await value;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected failure");
}
