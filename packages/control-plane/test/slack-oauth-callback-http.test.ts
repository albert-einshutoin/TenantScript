import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  SLACK_OAUTH_BROWSER_BINDING_COOKIE,
  SlackOAuthCallbackError,
  type SlackOAuthCallbackService
} from "../src/index.js";

const callbackPath = "/v1/provider-callbacks/slack";
const callbackOrigin = "https://control.example.test";
const successRedirectUri = "https://admin.example.test/settings/providers/slack/success";
const failureRedirectUri = "https://admin.example.test/settings/providers/slack/failure";
const state = "s".repeat(43);
const browserBinding = "b".repeat(43);
const code = "temporary-slack-code";
const clearCookie = `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None`;

describe("Slack OAuth callback HTTP boundary", () => {
  it("completes the closed callback input and redirects without reflecting secrets", async () => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>().mockResolvedValue(connection());
    const handler = createHandler({ complete });

    const response = await handler(callbackRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(successRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
    expect(complete).toHaveBeenCalledWith({ state, browserBinding, code });
    expect([...response.headers.entries()].join("\n")).not.toContain(code);
    expect([...response.headers.entries()].join("\n")).not.toContain(state);
    expect([...response.headers.entries()].join("\n")).not.toContain(browserBinding);
  });

  it.each([
    "slack_oauth_callback_invalid_request",
    "slack_oauth_callback_invalid_state",
    "slack_oauth_callback_rejected",
    "slack_oauth_callback_unavailable"
  ] as const)("maps %s to the same fixed secret-free failure redirect", async (errorCode) => {
    const secret = "provider-secret-sentinel";
    const complete = vi
      .fn<SlackOAuthCallbackService["complete"]>()
      .mockRejectedValue(Object.assign(new SlackOAuthCallbackError(errorCode), { secret }));
    const response = await createHandler({ complete })(callbackRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(failureRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(await response.text()).toBe("");
    expect([...response.headers.entries()].join("\n")).not.toContain(secret);
    expect([...response.headers.entries()].join("\n")).not.toContain(errorCode);
  });

  it.each([
    ["missing state", `code=${code}`],
    ["missing code", `state=${state}`],
    ["unknown authority field", `state=${state}&code=${code}&tenantId=attacker`],
    ["duplicate state", `state=${state}&state=${state}&code=${code}`],
    ["duplicate code", `state=${state}&code=${code}&code=${code}`],
    ["weak state", `state=short&code=${code}`],
    ["oversized code", `state=${state}&code=${"x".repeat(4_097)}`]
  ])("rejects %s before the callback service", async (_label, query) => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>();
    const response = await createHandler({ complete })(
      new Request(`${callbackOrigin}${callbackPath}?${query}`, {
        headers: callbackNavigationHeaders(
          `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}`
        )
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(failureRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["missing cookie", undefined],
    ["weak binding", `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=short`],
    [
      "duplicate binding",
      `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}; ${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}`
    ],
    ["oversized cookie header", `unrelated=${"x".repeat(8_193)}`]
  ])("rejects %s and clears the binding cookie", async (_label, cookie) => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>();
    const headers = callbackNavigationHeaders(cookie);
    const response = await createHandler({ complete })(
      new Request(`${callbackOrigin}${callbackPath}?state=${state}&code=${code}`, { headers })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(failureRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects methods other than GET while still clearing the binding cookie", async () => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>();
    const response = await createHandler({ complete })(
      new Request(`${callbackOrigin}${callbackPath}`, {
        method: "POST",
        headers: { Cookie: `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}` }
      })
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects an Origin-bearing subresource request before consuming state", async () => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>();
    const request = callbackRequest();
    request.headers.set("Origin", "https://attacker.example");

    const response = await createHandler({ complete })(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(failureRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a no-CORS image subresource without an Origin before consuming state", async () => {
    const complete = vi.fn<SlackOAuthCallbackService["complete"]>();
    const request = callbackRequest();
    request.headers.delete("Sec-Fetch-Mode");
    request.headers.delete("Sec-Fetch-Dest");
    request.headers.set("Sec-Fetch-Mode", "no-cors");
    request.headers.set("Sec-Fetch-Dest", "image");

    const response = await createHandler({ complete })(request);

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(failureRedirectUri);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(complete).not.toHaveBeenCalled();
  });

  it("fails closed when the callback service is not configured", async () => {
    const response = await createControlPlaneHttpHandler({})(callbackRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toBe(clearCookie);
    expect(await response.json()).toEqual({
      error: {
        code: "slack_oauth_callback_unavailable",
        message: "Slack OAuth callback unavailable"
      }
    });
  });

  it.each([
    ["non-HTTPS success", "http://admin.example.test/success", failureRedirectUri],
    ["credentialed failure", successRedirectUri, "https://user@admin.example.test/failure"],
    ["fragmented success", `${successRedirectUri}#secret`, failureRedirectUri],
    ["ambiguous destination", successRedirectUri, successRedirectUri]
  ])("rejects %s redirect configuration at composition time", (_label, success, failure) => {
    expect(() =>
      createControlPlaneHttpHandler(
        callbackOptions({ complete: () => Promise.resolve(connection()) }, success, failure)
      )
    ).toThrow();
  });
});

function createHandler(service: SlackOAuthCallbackService) {
  return createControlPlaneHttpHandler(
    callbackOptions(service, successRedirectUri, failureRedirectUri)
  );
}

function callbackOptions(
  service: SlackOAuthCallbackService,
  success: string,
  failure: string
): Parameters<typeof createControlPlaneHttpHandler>[0] {
  return {
    slackOAuthCallback: {
      service,
      successRedirectUri: success,
      failureRedirectUri: failure
    }
  };
}

function callbackRequest(): Request {
  return new Request(`${callbackOrigin}${callbackPath}?state=${state}&code=${code}`, {
    headers: callbackNavigationHeaders(`${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${browserBinding}`)
  });
}

function callbackNavigationHeaders(cookie?: string): Headers {
  const headers = new Headers({
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate"
  });
  if (cookie !== undefined) headers.set("Cookie", cookie);
  return headers;
}

function connection() {
  return {
    id: "slack:tenant:T123",
    tenantId: "tenant",
    workspaceId: "T123",
    secretRef: { provider: "slack" as const, tenantId: "tenant", secretId: "slack:T123" },
    connectedAt: new Date("2026-07-21T01:00:00.000Z")
  };
}
