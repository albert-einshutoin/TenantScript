import { describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  createHttpAdminSessionClient,
  type AdminSession
} from "./api-client.js";

describe("Admin HTTP session client", () => {
  it("sends the token only in Authorization and keeps it in memory", async () => {
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
      token: "secret-token",
      subject: "ops-manager",
      role: "manager",
      appId: "app_acme",
      tenantId: "tenant_acme"
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://api.example.com/v1/session");
    expect(String(url)).not.toContain("secret-token");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
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
