import { describe, expect, it } from "vitest";
import { createControlPlaneHttpHandler } from "../src/http-api.js";
import { createStaticTokenIdentityResolver } from "../src/index.js";

const allowedOrigin = "https://admin.example.com";

describe("Control Plane HTTP session contract", () => {
  it("returns a tenant-scoped session without echoing the bearer token", async () => {
    const handler = createHandler();
    const response = await handler(
      sessionRequest({
        token: "manager-secret-token",
        url: "https://api.example.com/v1/session?tenantId=tenant_other&appId=app_other"
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    const body = await response.json();
    expect(body).toEqual({
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    });
    expect(JSON.stringify(body)).not.toContain("manager-secret-token");
    expect(JSON.stringify(body)).not.toContain("tenant_other");
  });

  it.each([
    ["missing authorization", undefined],
    ["empty bearer", "Bearer "],
    ["wrong scheme", "Basic abc"],
    ["unknown token", "Bearer unknown"]
  ])("returns 401 for %s", async (_label, authorization) => {
    const handler = createHandler();
    const headers = new Headers({ Origin: allowedOrigin });
    if (authorization !== undefined) {
      headers.set("Authorization", authorization);
    }

    const response = await handler(new Request("https://api.example.com/v1/session", { headers }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({
      error: { code: "unauthorized", message: "valid bearer token required" }
    });
  });

  it.each([
    ["missing app scope", { subject: "user", role: "manager", tenantId: "tenant_acme" }],
    ["missing tenant scope", { subject: "user", role: "manager", appId: "app_acme" }],
    [
      "unsupported role",
      { subject: "user", role: "operator", appId: "app_acme", tenantId: "tenant_acme" }
    ]
  ])("returns 403 for %s", async (_label, identity) => {
    const handler = createControlPlaneHttpHandler({
      identityResolver: createStaticTokenIdentityResolver({ invalid: identity }),
      allowedOrigins: [allowedOrigin]
    });

    const response = await handler(sessionRequest({ token: "invalid" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "admin_scope_forbidden", message: "tenant-scoped admin access required" }
    });
  });

  it("fails closed when the identity resolver is not configured", async () => {
    const handler = createControlPlaneHttpHandler({ allowedOrigins: [allowedOrigin] });

    const response = await handler(sessionRequest({ token: "manager-secret-token" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "identity_resolver_unavailable",
        message: "identity service unavailable"
      }
    });
  });

  it("returns a redacted 500 response when identity resolution fails", async () => {
    const secret = "do-not-leak-this-token";
    const handler = createControlPlaneHttpHandler({
      identityResolver: {
        resolveToken: () => {
          throw new Error(`provider failed with ${secret}`);
        }
      },
      allowedOrigins: [allowedOrigin]
    });

    const response = await handler(sessionRequest({ token: secret }));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toContain("internal_error");
    expect(body).not.toContain(secret);
    expect(body).not.toContain("provider failed");
  });

  it("returns typed method and route errors", async () => {
    const handler = createHandler();

    const methodResponse = await handler(
      new Request("https://api.example.com/v1/session", {
        method: "POST",
        headers: { Origin: allowedOrigin }
      })
    );
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get("allow")).toBe("GET, OPTIONS");
    await expect(methodResponse.json()).resolves.toEqual({
      error: { code: "method_not_allowed", message: "method not allowed" }
    });

    const routeResponse = await handler(
      new Request("https://api.example.com/v1/unknown", {
        headers: { Origin: allowedOrigin }
      })
    );
    expect(routeResponse.status).toBe(404);
    await expect(routeResponse.json()).resolves.toEqual({
      error: { code: "route_not_found", message: "route not found" }
    });
  });

  it("rejects remote plaintext origins but allows loopback development origins", () => {
    expect(() =>
      createControlPlaneHttpHandler({ allowedOrigins: ["http://admin.example.com"] })
    ).toThrow("Admin API origins must use https except for loopback development");
    expect(() =>
      createControlPlaneHttpHandler({ allowedOrigins: ["http://localhost:4180"] })
    ).not.toThrow();
  });
});

function createHandler() {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      "manager-secret-token": {
        subject: "ops-manager",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      }
    }),
    allowedOrigins: [allowedOrigin]
  });
}

function sessionRequest(params: { token: string; url?: string }): Request {
  return new Request(params.url ?? "https://api.example.com/v1/session", {
    headers: {
      Authorization: `Bearer ${params.token}`,
      Origin: allowedOrigin
    }
  });
}
