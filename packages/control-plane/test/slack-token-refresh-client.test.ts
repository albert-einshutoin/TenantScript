import { describe, expect, it, vi } from "vitest";
import {
  createSlackTokenRefreshClient,
  SlackTokenRefreshError
} from "../src/slack-token-refresh-client.js";

describe("Slack token refresh client", () => {
  it("posts a refresh token once to the fixed OAuth endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: "xoxe.xoxb-2-synthetic-access",
        token_type: "bot",
        scope: "chat:write,commands",
        expires_in: 43_200,
        refresh_token: "xoxe-2-synthetic-refresh"
      })
    );
    const client = createSlackTokenRefreshClient({
      clientId: "123456789.987654321",
      clientSecret: "synthetic-client-secret",
      fetcher
    });

    await expect(client.refresh("xoxe-1-synthetic-refresh")).resolves.toEqual({
      accessToken: "xoxe.xoxb-2-synthetic-access",
      refreshToken: "xoxe-2-synthetic-refresh",
      expiresIn: 43_200
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://slack.com/api/oauth.v2.access");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      `Basic ${btoa("123456789.987654321:synthetic-client-secret")}`
    );
    expect(new URLSearchParams(init?.body as string)).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "xoxe-1-synthetic-refresh"
      })
    );
  });

  it.each([
    ["provider rejection", () => Response.json({ ok: false, error: "invalid_refresh_token" })],
    ["HTTP failure", () => new Response("provider-secret", { status: 503 })],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } })
    ],
    ["malformed response", () => Response.json({ ok: true, access_token: "secret-only" })]
  ])("fails closed without retrying on %s", async (_label, response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response());
    const client = createSlackTokenRefreshClient({
      clientId: "123456789.987654321",
      clientSecret: "synthetic-client-secret",
      fetcher
    });

    const failure = await captureFailure(client.refresh("xoxe-1-synthetic-refresh"));

    expect(failure).toBeInstanceOf(SlackTokenRefreshError);
    expect((failure as SlackTokenRefreshError).toJSON()).toEqual({
      code: "slack_token_refresh_intervention_required"
    });
    expect(JSON.stringify(failure)).not.toContain("provider-secret");
    expect(JSON.stringify(failure)).not.toContain("synthetic-refresh");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid input before provider access", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createSlackTokenRefreshClient({
      clientId: "123456789.987654321",
      clientSecret: "synthetic-client-secret",
      fetcher
    });

    await expect(client.refresh("")).rejects.toMatchObject({
      code: "slack_token_refresh_invalid_request"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function captureFailure(value: Promise<unknown>): Promise<unknown> {
  try {
    await value;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected failure");
}
