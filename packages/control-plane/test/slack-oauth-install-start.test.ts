import { describe, expect, it } from "vitest";
import {
  createSlackOAuthInstallStartService,
  SlackOAuthInstallStartError,
  type OAuthStateStore
} from "../src/index.js";

const issuedAt = new Date("2026-07-21T01:00:00.000Z");
const expiresAt = new Date("2026-07-21T01:05:00.000Z");
const state = "s".repeat(43);

describe("Slack OAuth install-start service", () => {
  it("binds server-owned identity and redirect scope to state and a hardened browser cookie", async () => {
    const calls: Parameters<OAuthStateStore["issue"]>[0][] = [];
    const service = createSlackOAuthInstallStartService({
      stateStore: stateStore(calls),
      clientId: "123456789.987654321",
      scopes: ["commands", "chat:write"],
      redirectUri: "https://control.example.com/v1/provider-callbacks/slack",
      now: () => issuedAt,
      randomBytes: (length) => new Uint8Array(length)
    });

    const result = await service.start({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actorSubject: "manager_1"
    });

    expect(calls).toEqual([
      {
        provider: "slack",
        appId: "app_acme",
        tenantId: "tenant_acme",
        actorSubject: "manager_1",
        browserBinding: "A".repeat(43),
        redirectUri: "https://control.example.com/v1/provider-callbacks/slack"
      }
    ]);
    const authorizationUrl = new URL(result.authorizationUrl);
    expect(authorizationUrl.origin).toBe("https://slack.com");
    expect(authorizationUrl.pathname).toBe("/oauth/v2/authorize");
    expect([...authorizationUrl.searchParams.entries()]).toEqual([
      ["client_id", "123456789.987654321"],
      ["scope", "chat:write,commands"],
      ["redirect_uri", "https://control.example.com/v1/provider-callbacks/slack"],
      ["state", state]
    ]);
    expect(result.expiresAt).toEqual(expiresAt);
    expect(result.browserBindingCookie).toBe(
      `__Host-tenantscript-slack-oauth-binding=${"A".repeat(43)}; Path=/; Max-Age=300; Expires=Tue, 21 Jul 2026 01:05:00 GMT; Secure; HttpOnly; SameSite=Lax`
    );
    expect(result.browserBindingCookie).not.toContain("Domain=");
    expect(JSON.stringify(result)).not.toContain('browserBinding":');
  });

  it("preserves a bounded opaque identity-provider subject", async () => {
    const calls: Parameters<OAuthStateStore["issue"]>[0][] = [];
    const service = createService(stateStore(calls));

    await service.start({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actorSubject: "auth0|abc+operator@example.com"
    });

    expect(calls[0]?.actorSubject).toBe("auth0|abc+operator@example.com");
  });

  it.each([
    [{ appId: "", tenantId: "tenant", actorSubject: "actor" }],
    [{ appId: "app", tenantId: "tenant", actorSubject: "actor", redirectUri: "https://evil" }],
    [{ appId: "app", tenantId: "tenant", actorSubject: "actor", browserBinding: "attacker" }]
  ])("rejects malformed or extended start input before issuing state", async (input) => {
    const calls: Parameters<OAuthStateStore["issue"]>[0][] = [];
    const service = createService(stateStore(calls));

    await expect(service.start(input as never)).rejects.toMatchObject({
      code: "slack_oauth_install_start_invalid_request"
    });
    expect(calls).toEqual([]);
  });

  it.each([
    { clientId: "", scopes: ["commands"], redirectUri: "https://control.example/callback" },
    { clientId: "123.456", scopes: [], redirectUri: "https://control.example/callback" },
    {
      clientId: "123.456",
      scopes: ["commands", "commands"],
      redirectUri: "https://control.example/callback"
    },
    { clientId: "123.456", scopes: ["commands"], redirectUri: "http://control.example/callback" },
    { clientId: "123.456", scopes: ["commands"], redirectUri: "https://user@control.example/cb" }
  ])("rejects unsafe trusted configuration %#", (configuration) => {
    expect(() =>
      createSlackOAuthInstallStartService({
        stateStore: stateStore([]),
        ...configuration
      })
    ).toThrow(expect.objectContaining({ code: "slack_oauth_install_start_invalid_configuration" }));
  });

  it.each([
    ["clock", { now: () => new Date(Number.NaN) }],
    ["random source", { randomBytes: () => new Uint8Array(31) }]
  ])("maps a broken %s to a stable unavailable error", async (_label, overrides) => {
    const service = createService(stateStore([]), overrides);

    await expect(
      service.start({ appId: "app", tenantId: "tenant", actorSubject: "actor" })
    ).rejects.toEqual(new SlackOAuthInstallStartError("slack_oauth_install_start_unavailable"));
  });

  it("redacts state-store failures and invalid expiry values", async () => {
    const secret = "state-store-secret-detail";
    const failing = createService({
      issue: () => Promise.reject(new Error(secret)),
      consume: () => Promise.reject(new Error("unused"))
    });
    const invalidExpiry = createService({
      issue: () => Promise.resolve({ state, expiresAt: new Date(issuedAt) }),
      consume: () => Promise.reject(new Error("unused"))
    });

    for (const service of [failing, invalidExpiry]) {
      const error = await service
        .start({ appId: "app", tenantId: "tenant", actorSubject: "actor" })
        .catch((caught: unknown) => caught);
      expect(error).toEqual(
        new SlackOAuthInstallStartError("slack_oauth_install_start_unavailable")
      );
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(state);
    }
  });
});

function createService(
  store: OAuthStateStore,
  overrides: {
    now?: () => Date;
    randomBytes?: (length: number) => Uint8Array;
  } = {}
) {
  return createSlackOAuthInstallStartService({
    stateStore: store,
    clientId: "123.456",
    scopes: ["commands"],
    redirectUri: "https://control.example.com/v1/provider-callbacks/slack",
    now: () => issuedAt,
    randomBytes: (length) => new Uint8Array(length),
    ...overrides
  });
}

function stateStore(calls: Parameters<OAuthStateStore["issue"]>[0][]): OAuthStateStore {
  return {
    issue: (input) => {
      calls.push(input);
      return Promise.resolve({ state, expiresAt });
    },
    consume: () => Promise.reject(new Error("unused"))
  };
}
