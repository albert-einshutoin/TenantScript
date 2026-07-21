import { describe, expect, it, vi } from "vitest";
import { createSlackOAuthClient, SlackOAuthExchangeError } from "../src/index.js";

const redirectUri = "https://admin.example.test/oauth/slack/callback";

describe("Slack OAuth v2 exchange client", () => {
  it("posts once to the fixed endpoint and returns only the safe workspace projection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: "xoxb-synthetic-access-token",
        token_type: "bot",
        scope: "chat:write,commands",
        bot_user_id: "B12345678",
        app_id: "A12345678",
        team: { id: "T12345678", name: "Synthetic Workspace" },
        enterprise: { id: "E12345678", name: "Synthetic Enterprise" },
        authed_user: {
          id: "U12345678",
          scope: "",
          access_token: "xoxp-synthetic-user-token",
          token_type: "user"
        },
        is_enterprise_install: false
      })
    );
    const client = createSlackOAuthClient({
      clientId: "123456789.987654321",
      clientSecret: "synthetic-client-secret",
      allowedRedirectUris: [redirectUri],
      fetcher
    });

    const result = await client.exchangeCode({
      code: "synthetic-one-time-code",
      redirectUri
    });

    expect(result).toEqual({
      accessToken: "xoxb-synthetic-access-token",
      workspaceId: "T12345678",
      workspaceName: "Synthetic Workspace",
      botUserId: "B12345678"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded; charset=utf-8"
    );
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("123456789.987654321:synthetic-client-secret")}`
    );
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") throw new Error("expected encoded OAuth body");
    expect(new URLSearchParams(init.body)).toEqual(
      new URLSearchParams({ code: "synthetic-one-time-code", redirect_uri: redirectUri })
    );
  });

  it("returns a closed bot token-rotation credential projection", async () => {
    const client = oauthClient(() =>
      Promise.resolve(
        Response.json({
          ok: true,
          access_token: "xoxe.xoxb-1-synthetic-access-token",
          token_type: "bot",
          scope: "chat:write,commands",
          bot_user_id: "B12345678",
          app_id: "A12345678",
          expires_in: 43_200,
          refresh_token: "xoxe-1-synthetic-refresh-token",
          team: { id: "T12345678", name: "Synthetic Workspace" },
          enterprise: { id: "E12345678", name: "Synthetic Enterprise" },
          authed_user: {
            id: "U12345678",
            scope: "chat:write"
          }
        })
      )
    );

    await expect(
      client.exchangeCode({ code: "synthetic-one-time-code", redirectUri })
    ).resolves.toEqual({
      accessToken: "xoxe.xoxb-1-synthetic-access-token",
      refreshToken: "xoxe-1-synthetic-refresh-token",
      expiresIn: 43_200,
      workspaceId: "T12345678",
      workspaceName: "Synthetic Workspace",
      botUserId: "B12345678"
    });
  });

  it("rejects enterprise-wide installs until connection scope is modeled", async () => {
    const client = oauthClient(() =>
      Promise.resolve(
        Response.json({
          ok: true,
          access_token: "xoxb-enterprise-secret-sentinel",
          token_type: "bot",
          scope: "chat:write,commands",
          bot_user_id: "B12345678",
          app_id: "A12345678",
          team: { id: "T12345678", name: "Synthetic Workspace" },
          enterprise: { id: "E12345678", name: "Synthetic Enterprise" },
          authed_user: { id: "U12345678", scope: "" },
          is_enterprise_install: true
        })
      )
    );

    const error = await captureExchangeError(
      client.exchangeCode({ code: "synthetic-one-time-code", redirectUri })
    );

    expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_unavailable" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it.each([
    ["unknown configuration field", { unexpected: "secret-sentinel" }],
    ["empty client ID", { clientId: "" }],
    ["client ID with a colon", { clientId: "client:id" }],
    ["empty client secret", { clientSecret: "" }],
    ["non-ASCII client secret", { clientSecret: "synthetic-秘密" }],
    ["empty redirect allowlist", { allowedRedirectUris: [] }],
    ["duplicate redirect URI", { allowedRedirectUris: [redirectUri, redirectUri] }],
    ["HTTP redirect URI", { allowedRedirectUris: ["http://admin.example.test/callback"] }],
    ["redirect URI with userinfo", { allowedRedirectUris: ["https://user@example.test/callback"] }],
    ["redirect URI with a fragment", { allowedRedirectUris: [`${redirectUri}#secret-sentinel`] }],
    ["invalid timeout", { timeoutMs: 0 }],
    ["non-function fetcher", { fetcher: "secret-sentinel" }]
  ])("rejects %s before creating a client", (_label, override) => {
    expect(() =>
      createSlackOAuthClient({
        clientId: "123456789.987654321",
        clientSecret: "synthetic-client-secret",
        allowedRedirectUris: [redirectUri],
        ...override
      } as never)
    ).toThrow(expect.objectContaining({ code: "slack_oauth_invalid_configuration" }));
  });

  it.each([
    ["unknown request field", { code: "synthetic-code", redirectUri, extra: "secret-sentinel" }],
    ["empty code", { code: "", redirectUri }],
    ["code with whitespace", { code: "synthetic code", redirectUri }],
    ["unapproved redirect", { code: "synthetic-code", redirectUri: "https://evil.example/cb" }],
    ["missing redirect", { code: "synthetic-code" }]
  ])("rejects %s before provider access", async (_label, request) => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createSlackOAuthClient({
      clientId: "123456789.987654321",
      clientSecret: "synthetic-client-secret",
      allowedRedirectUris: [redirectUri],
      fetcher
    });

    const error = await captureExchangeError(client.exchangeCode(request as never));

    expect(error.toJSON()).toEqual({ code: "slack_oauth_invalid_request" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies a provider rejection without reflecting its error or credentials", async () => {
    const client = oauthClient(() =>
      Promise.resolve(Response.json({ ok: false, error: "bad_client_secret-secret-sentinel" }))
    );

    const error = await captureExchangeError(
      client.exchangeCode({ code: "synthetic-code", redirectUri })
    );

    expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_rejected" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
    expect(JSON.stringify(error)).not.toContain("synthetic-client-secret");
    expect(JSON.stringify(error)).not.toContain("synthetic-code");
  });

  it.each(["service_unavailable", "internal_error", "request_timeout", "ratelimited"])(
    "classifies transient provider error %s as unavailable without reflecting it",
    async (providerError) => {
      const client = oauthClient(() =>
        Promise.resolve(Response.json({ ok: false, error: providerError }))
      );

      const error = await captureExchangeError(
        client.exchangeCode({ code: "synthetic-code", redirectUri })
      );

      expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_unavailable" });
      expect(JSON.stringify(error)).not.toContain(providerError);
    }
  );

  it.each([
    ["HTTP failure", () => new Response("upstream-secret-sentinel", { status: 503 })],
    [
      "redirect response",
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
    ],
    ["malformed JSON", () => new Response("{not-json", { status: 200 })],
    [
      "missing workspace",
      () =>
        Response.json({
          ok: true,
          access_token: "xoxb-secret-sentinel",
          token_type: "bot",
          scope: "chat:write",
          app_id: "A123",
          authed_user: { id: "U123", scope: "" }
        })
    ],
    [
      "user token instead of bot token",
      () =>
        Response.json({
          ok: true,
          access_token: "xoxp-secret-sentinel",
          token_type: "user",
          scope: "chat:write",
          app_id: "A123",
          team: { id: "T123", name: "Synthetic" },
          authed_user: { id: "U123", scope: "" }
        })
    ],
    [
      "unknown success field",
      () =>
        Response.json({
          ok: true,
          access_token: "xoxb-secret-sentinel",
          token_type: "bot",
          scope: "chat:write",
          app_id: "A123",
          team: { id: "T123", name: "Synthetic" },
          authed_user: { id: "U123", scope: "" },
          unknown_secret_field: "secret-sentinel"
        })
    ],
    [
      "refresh token without expiry",
      () => Response.json(rotationResponse({ expires_in: undefined }))
    ],
    [
      "expiry without refresh token",
      () => Response.json(rotationResponse({ refresh_token: undefined }))
    ],
    ["invalid rotation expiry", () => Response.json(rotationResponse({ expires_in: 0 }))],
    [
      "oversized rotation token",
      () => Response.json(rotationResponse({ refresh_token: "x".repeat(16_385) }))
    ],
    [
      "rotating user credential mixed into bot response",
      () =>
        Response.json(
          rotationResponse({
            authed_user: {
              id: "U123",
              scope: "chat:write",
              access_token: "xoxe.xoxp-1-user-access",
              token_type: "user",
              expires_in: 43_200,
              refresh_token: "xoxe-1-user-refresh"
            }
          })
        )
    ],
    [
      "oversized body",
      () =>
        new Response(`{"ok":true,"padding":"${"x".repeat(65_536)}secret-sentinel"}`, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    ]
  ])("fails closed for %s", async (_label, response) => {
    const client = oauthClient(() => Promise.resolve(response()));

    const error = await captureExchangeError(
      client.exchangeCode({ code: "synthetic-code", redirectUri })
    );

    expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_unavailable" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("classifies a network failure without retrying the one-time code", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network-secret-sentinel"));
    const client = oauthClient(fetcher);

    const error = await captureExchangeError(
      client.exchangeCode({ code: "synthetic-code", redirectUri })
    );

    expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("keeps the timeout active until the response body is fully read", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new Error("body-secret-sentinel"));
              });
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });
    const client = oauthClient(fetcher, { timeoutMs: 20 });

    const error = await captureExchangeError(
      client.exchangeCode({ code: "synthetic-code", redirectUri })
    );

    expect(error.toJSON()).toEqual({ code: "slack_oauth_exchange_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function rotationResponse(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: true,
    access_token: "xoxe.xoxb-1-synthetic-access",
    token_type: "bot",
    scope: "chat:write",
    app_id: "A123",
    expires_in: 43_200,
    refresh_token: "xoxe-1-synthetic-refresh",
    team: { id: "T123", name: "Synthetic" },
    enterprise: null,
    authed_user: { id: "U123", scope: "" },
    ...overrides
  };
}

function oauthClient(
  fetcher: typeof fetch,
  override: { timeoutMs?: number } = {}
): ReturnType<typeof createSlackOAuthClient> {
  return createSlackOAuthClient({
    clientId: "123456789.987654321",
    clientSecret: "synthetic-client-secret",
    allowedRedirectUris: [redirectUri],
    fetcher,
    ...override
  });
}

async function captureExchangeError(value: unknown): Promise<SlackOAuthExchangeError> {
  try {
    await value;
  } catch (error) {
    if (error instanceof SlackOAuthExchangeError) return error;
    throw error;
  }
  throw new Error("expected Slack OAuth exchange failure");
}
