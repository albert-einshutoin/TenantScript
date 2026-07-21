import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  SlackOAuthInstallStartError,
  type SlackOAuthInstallStartService
} from "../src/index.js";

const allowedOrigin = "https://admin.example.com";
const endpoint = "https://control.example.com/v1/admin/provider-connections/slack/oauth/start";
const cookie =
  "__Host-tenantscript-slack-oauth-binding=browser-secret; Path=/; Max-Age=300; Expires=Tue, 21 Jul 2026 01:05:00 GMT; Secure; HttpOnly; SameSite=Lax";

describe("Slack OAuth install-start HTTP endpoint", () => {
  it("derives OAuth scope from the authenticated identity and sets the browser cookie", async () => {
    const start = vi.fn<SlackOAuthInstallStartService["start"]>().mockResolvedValue({
      authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${"s".repeat(43)}`,
      expiresAt: new Date("2026-07-21T01:05:00.000Z"),
      browserBindingCookie: cookie
    });
    const handler = createHandler({ start });

    const response = await handler(request("admin"));

    expect(response.status).toBe(201);
    expect(start).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actorSubject: "admin_subject"
    });
    expect(response.headers.get("set-cookie")).toBe(cookie);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    const body = await response.json();
    expect(body).toEqual({
      authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${"s".repeat(43)}`,
      expiresAt: "2026-07-21T01:05:00.000Z"
    });
    expect(JSON.stringify(body)).not.toContain("browser-secret");
  });

  it("advertises credentialed POST for the exact allowed browser origin", async () => {
    const handler = createHandler({ start: () => Promise.resolve(result()) });

    const response = await handler(
      new Request(endpoint, {
        method: "OPTIONS",
        headers: {
          Origin: allowedOrigin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization"
        }
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it.each([
    ["owner", 201],
    ["admin", 201],
    ["tenant-admin", 201],
    ["manager", 201],
    ["operator", 403],
    ["viewer", 403]
  ])("enforces provider connection management for %s", async (role, status) => {
    const start = vi.fn<SlackOAuthInstallStartService["start"]>().mockResolvedValue(result());
    const handler = createHandler({ start }, role);

    const response = await handler(request(role));

    expect(response.status).toBe(status);
    expect(start).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
  });

  it("requires authentication and an explicit service-token operation before issuing state", async () => {
    const start = vi.fn<SlackOAuthInstallStartService["start"]>().mockResolvedValue(result());
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({
        scoped: {
          subject: "scoped_subject",
          role: "admin",
          appId: "app_acme",
          tenantId: "tenant_acme",
          allowedOperations: ["session:read"]
        }
      }),
      slackOAuthInstallStartService: { start },
      allowedOrigins: [allowedOrigin]
    });

    const unauthenticated = await handler(
      new Request(endpoint, { method: "POST", headers: { Origin: allowedOrigin } })
    );
    const narrowToken = await handler(request("scoped"));

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Bearer");
    expect(narrowToken.status).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it("reserves the tenant and actor mutation budget before issuing state", async () => {
    const start = vi.fn<SlackOAuthInstallStartService["start"]>().mockResolvedValue(result());
    const reserve = vi.fn().mockResolvedValue({ allowed: true as const, remaining: 3 });
    const protectedHandler = createHandler({ start }, "admin", reserve);
    const unprotectedHandler = createControlPlaneHttpHandler({
      identityResolver: identities("admin"),
      slackOAuthInstallStartService: { start },
      allowedOrigins: [allowedOrigin]
    });

    const protectedResponse = await protectedHandler(request("admin"));
    const unprotectedResponse = await unprotectedHandler(request("admin"));

    expect(protectedResponse.status).toBe(201);
    expect(reserve).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "admin_subject",
      family: "provider-oauth-start"
    });
    expect(unprotectedResponse.status).toBe(503);
    expect(await unprotectedResponse.text()).toContain("admin_mutation_rate_limit_unavailable");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["query override", `${endpoint}?tenantId=other`, undefined],
    ["empty JSON body", endpoint, "{}"],
    ["scope override", endpoint, JSON.stringify({ scope: "admin" })]
  ])("rejects %s without issuing state", async (_label, url, body) => {
    const start = vi.fn<SlackOAuthInstallStartService["start"]>().mockResolvedValue(result());
    const handler = createHandler({ start });
    const headers = new Headers({ Authorization: "Bearer admin", Origin: allowedOrigin });
    if (body !== undefined) headers.set("Content-Type", "application/json");

    const response = await handler(
      new Request(url, { method: "POST", headers, ...(body === undefined ? {} : { body }) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "slack_oauth_install_start_invalid_request",
        message: "invalid Slack OAuth install-start request"
      }
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("fails closed when the service is missing or returns an internal secret", async () => {
    const unavailable = createControlPlaneHttpHandler({
      identityResolver: identities("admin"),
      allowedOrigins: [allowedOrigin]
    });
    const secret = "state-store-internal-secret";
    const failing = createHandler({
      start: () =>
        Promise.reject(
          Object.assign(new SlackOAuthInstallStartError("slack_oauth_install_start_unavailable"), {
            internal: secret
          })
        )
    });

    for (const handler of [unavailable, failing]) {
      const response = await handler(request("admin"));
      const text = await response.text();
      expect(response.status).toBe(503);
      expect(text).toContain("slack_oauth_install_start_unavailable");
      expect(text).not.toContain(secret);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });
});

function result() {
  return {
    authorizationUrl: `https://slack.com/oauth/v2/authorize?state=${"s".repeat(43)}`,
    expiresAt: new Date("2026-07-21T01:05:00.000Z"),
    browserBindingCookie: cookie
  };
}

function createHandler(
  service: SlackOAuthInstallStartService,
  role = "admin",
  reserve = () => Promise.resolve({ allowed: true as const, remaining: 9 })
) {
  return createControlPlaneHttpHandler({
    identityResolver: identities(role),
    slackOAuthInstallStartService: service,
    adminMutationRateLimiter: { reserve },
    allowedOrigins: [allowedOrigin]
  });
}

function identities(role: string) {
  return createStaticTokenIdentityResolver({
    [role]: {
      subject: `${role}_subject`,
      role,
      appId: "app_acme",
      tenantId: "tenant_acme"
    }
  });
}

function request(token: string) {
  return new Request(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: allowedOrigin }
  });
}
