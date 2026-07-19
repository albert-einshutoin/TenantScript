import { describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  createAdminApiClient,
  createHttpAdminSessionClient,
  type AdminSession
} from "./api-client.js";

describe("Admin API environment selection", () => {
  it("connects the production client to the configured Control Plane", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        subject: "ops-manager",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      })
    );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });

    await expect(client.resolveSession({ token: "production-token" })).resolves.toMatchObject({
      subject: "ops-manager",
      tenantId: "tenant_acme"
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("never enables fixture credentials in a production build", async () => {
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: true
    });

    await expect(client.resolveSession({ token: "manager-token" })).rejects.toEqual(
      new AdminApiError(503, "control_plane_not_configured", "Control Plane not configured")
    );
  });
});

describe("Admin HTTP session client", () => {
  it("sends the token only in Authorization and returns identity without the credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        subject: "ops-manager",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      })
    );
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com/",
      fetcher
    });

    const session = await client.resolveSession({ token: "secret-token" });

    expect(session).toEqual<AdminSession>({
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    const requestUrl =
      typeof url === "string" ? url : url instanceof URL ? url.href : (url?.url ?? "");
    expect(requestUrl).toBe("https://api.example.com/v1/session");
    expect(requestUrl).not.toContain("secret-token");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("rejects remote plaintext HTTP but allows loopback development URLs", () => {
    expect(() => createHttpAdminSessionClient({ baseUrl: "http://api.example.com" })).toThrow(
      "control-plane URL must use https except for loopback development"
    );
    expect(() => createHttpAdminSessionClient({ baseUrl: "http://127.0.0.1:8787" })).not.toThrow();
  });

  it("converts an HTTP error envelope into a typed error", async () => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            error: {
              code: "admin_scope_forbidden",
              message: "tenant-scoped admin access required"
            }
          },
          { status: 403 }
        )
      )
    });

    await expect(client.resolveSession({ token: "viewer" })).rejects.toEqual(
      new AdminApiError(403, "admin_scope_forbidden", "tenant-scoped admin access required")
    );
  });

  it("converts a network failure into a typed error without exposing provider details", async () => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockRejectedValue(new Error("socket secret: abc123"))
    });

    await expect(client.resolveSession({ token: "secret" })).rejects.toEqual(
      new AdminApiError(0, "network_error", "control-plane is unreachable")
    );
  });

  it.each([
    "https://user:password@api.example.com",
    "https://api.example.com?token=configuration-secret",
    "https://api.example.com#configuration-secret"
  ])("rejects an unsafe control-plane base URL: %s", (baseUrl) => {
    expect(() => createHttpAdminSessionClient({ baseUrl })).toThrow(
      "control-plane URL must not contain credentials, query, or fragment"
    );
  });

  it.each([
    ["missing tenant scope", { subject: "user", role: "manager", appId: "app_acme" }],
    [
      "unknown role",
      { subject: "user", role: "operator", appId: "app_acme", tenantId: "tenant_acme" }
    ],
    ["malformed payload", { ok: true }]
  ])("rejects %s as an invalid response", async (_label, payload) => {
    const client = createHttpAdminSessionClient({
      baseUrl: "https://api.example.com",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload))
    });

    await expect(client.resolveSession({ token: "secret" })).rejects.toEqual(
      new AdminApiError(502, "invalid_response", "control-plane returned an invalid response")
    );
  });
});
