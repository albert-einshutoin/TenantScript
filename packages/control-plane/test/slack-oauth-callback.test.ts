import { describe, expect, it, vi } from "vitest";
import {
  createSlackOAuthCallbackService,
  OAuthStateStoreError,
  SlackOAuthCallbackError,
  SlackOAuthExchangeError,
  type OAuthStateBinding,
  type OAuthStateStore
} from "../src/index.js";

const state = "A".repeat(43);
const browserBinding = "browser_session_abcdefghijklmnopqrstuvwxyz012345";
const code = "oauth_code_secret_sentinel";

describe("Slack OAuth callback service", () => {
  it("uses only server-owned state bindings for the downstream connection", async () => {
    const binding = validBinding();
    const consume = vi.fn().mockResolvedValue(binding);
    const connectSlackWorkspace = vi.fn().mockResolvedValue(connection());
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace,
      now: () => new Date("2026-07-21T01:00:00.000Z")
    });

    const result = await service.complete({ state, browserBinding, code });

    expect(result).toEqual(connection());
    expect(consume).toHaveBeenCalledWith({ state, browserBinding });
    expect(connectSlackWorkspace).toHaveBeenCalledWith({
      appId: binding.appId,
      tenantId: binding.tenantId,
      code,
      redirectUri: binding.redirectUri,
      connectedAt: new Date("2026-07-21T01:00:00.000Z")
    });
    expect(JSON.stringify(result)).not.toContain(code);
  });

  it.each([
    ["unknown field", { state, browserBinding, code, tenantId: "attacker_tenant" }],
    ["weak state", { state: "short", browserBinding, code }],
    ["weak browser binding", { state, browserBinding: "short", code }],
    ["empty code", { state, browserBinding, code: "" }],
    ["non-ASCII code", { state, browserBinding, code: "secret-\ncode" }]
  ])("rejects %s before state or provider access", async (_label, input) => {
    const consume = vi.fn();
    const connectSlackWorkspace = vi.fn();
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace
    });

    const failure = await captureError(service.complete(input));

    expect(failure.toJSON()).toEqual({ code: "slack_oauth_callback_invalid_request" });
    expect(consume).not.toHaveBeenCalled();
    expect(connectSlackWorkspace).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain("attacker_tenant");
  });

  it("maps unknown, expired, replayed, and browser-mismatched state without provider access", async () => {
    const consume = vi.fn().mockRejectedValue(new OAuthStateStoreError("oauth_state_invalid"));
    const connectSlackWorkspace = vi.fn();
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace
    });

    const failure = await captureError(service.complete({ state, browserBinding, code }));

    expect(failure.toJSON()).toEqual({ code: "slack_oauth_callback_invalid_state" });
    expect(connectSlackWorkspace).not.toHaveBeenCalled();
    expect(JSON.stringify(failure)).not.toContain(code);
    expect(JSON.stringify(failure)).not.toContain(state);
    expect(JSON.stringify(failure)).not.toContain(browserBinding);
  });

  it("fails closed if the state store is unavailable", async () => {
    const consume = vi
      .fn()
      .mockRejectedValue(new OAuthStateStoreError("oauth_state_store_unavailable"));
    const connectSlackWorkspace = vi.fn();
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace
    });

    const failure = await captureError(service.complete({ state, browserBinding, code }));

    expect(failure.toJSON()).toEqual({ code: "slack_oauth_callback_unavailable" });
    expect(connectSlackWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid date", () => new Date(Number.NaN)],
    [
      "throwing clock",
      () => {
        throw new Error("clock detail secret-sentinel");
      }
    ]
  ])("rejects an %s before consuming one-time state", async (_label, now) => {
    const consume = vi.fn();
    const connectSlackWorkspace = vi.fn();
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace,
      now
    });

    const failure = await captureError(service.complete({ state, browserBinding, code }));

    expect(failure.toJSON()).toEqual({ code: "slack_oauth_callback_unavailable" });
    expect(JSON.stringify(failure)).not.toContain("secret-sentinel");
    expect(consume).not.toHaveBeenCalled();
    expect(connectSlackWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    [
      "provider rejection",
      new SlackOAuthExchangeError("slack_oauth_exchange_rejected"),
      "slack_oauth_callback_rejected"
    ],
    [
      "provider or storage outage",
      new Error("provider token and internal detail secret-sentinel"),
      "slack_oauth_callback_unavailable"
    ]
  ])("returns a stable secret-free error for %s", async (_label, downstreamError, errorCode) => {
    const connectSlackWorkspace = vi.fn().mockRejectedValue(downstreamError);
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(vi.fn().mockResolvedValue(validBinding())),
      connectSlackWorkspace
    });

    const failure = await captureError(service.complete({ state, browserBinding, code }));

    expect(failure.toJSON()).toEqual({ code: errorCode });
    expect(JSON.stringify(failure)).not.toContain(code);
    expect(JSON.stringify(failure)).not.toContain("secret-sentinel");
  });

  it("allows at most one concurrent callback to reach the one-shot code exchange", async () => {
    let consumed = false;
    const consume = vi.fn(() => {
      if (consumed) throw new OAuthStateStoreError("oauth_state_invalid");
      consumed = true;
      return Promise.resolve(validBinding());
    });
    const connectSlackWorkspace = vi.fn().mockResolvedValue(connection());
    const service = createSlackOAuthCallbackService({
      stateStore: stateStore(consume),
      connectSlackWorkspace
    });

    const results = await Promise.allSettled([
      service.complete({ state, browserBinding, code }),
      service.complete({ state, browserBinding, code })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(connectSlackWorkspace).toHaveBeenCalledTimes(1);
  });
});

function stateStore(consume: OAuthStateStore["consume"]): OAuthStateStore {
  return {
    issue: vi.fn(),
    consume
  };
}

function validBinding(): OAuthStateBinding {
  return {
    provider: "slack",
    appId: "app_1",
    tenantId: "tenant_1",
    actorSubject: "manager_1",
    redirectUri: "https://admin.example.test/oauth/slack/callback",
    issuedAt: new Date("2026-07-21T00:55:00.000Z"),
    expiresAt: new Date("2026-07-21T01:00:00.000Z")
  };
}

function connection() {
  return {
    id: "slack:tenant_1:T123",
    tenantId: "tenant_1",
    workspaceId: "T123",
    workspaceName: "Acme",
    botUserId: "B123",
    secretRef: { provider: "slack", tenantId: "tenant_1", secretId: "slack:T123" },
    connectedAt: new Date("2026-07-21T01:00:00.000Z")
  };
}

async function captureError(value: Promise<unknown>): Promise<SlackOAuthCallbackError> {
  let failure: unknown;
  try {
    await value;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SlackOAuthCallbackError);
  return failure as SlackOAuthCallbackError;
}
