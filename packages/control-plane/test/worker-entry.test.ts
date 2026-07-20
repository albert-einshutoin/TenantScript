import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/index.js";
import worker, { runScheduledTelemetry } from "../src/worker-entry.js";

const validIdentities = JSON.stringify({
  "manager-token": {
    subject: "manager",
    role: "manager",
    appId: "app_1",
    tenantId: "tenant_1"
  }
});

describe("Control Plane Worker configuration", () => {
  it("creates a reachable session route from valid bindings", async () => {
    const response = await worker.fetch(sessionRequest("manager-token", true), {
      ADMIN_ALLOWED_ORIGINS: JSON.stringify(["https://admin.example.com"]),
      ADMIN_IDENTITIES_JSON: validIdentities
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subject: "manager",
      tenantId: "tenant_1"
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["array", "[]"],
    ["empty map", "{}"],
    ["empty token", JSON.stringify({ "": { subject: "manager" } })],
    ["non-object identity", JSON.stringify({ token: "manager" })]
  ])("fails closed for %s identity configuration", async (_label, identities) => {
    const response = await worker.fetch(sessionRequest("manager-token", false), {
      ...(identities === undefined ? {} : { ADMIN_IDENTITIES_JSON: identities })
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "identity_resolver_unavailable" }
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["non-array", "{}"],
    ["non-string member", "[1]"]
  ])("fails closed to browser origins for %s origin configuration", async (_label, origins) => {
    const response = await worker.fetch(sessionRequest("manager-token", true), {
      ...(origins === undefined ? {} : { ADMIN_ALLOWED_ORIGINS: origins }),
      ADMIN_IDENTITIES_JSON: validIdentities
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "origin_forbidden" }
    });
  });

  it.each(['["*"]', '["not-a-url"]', '["http://admin.example.com"]'])(
    "returns a redacted 503 for unsafe origin configuration: %s",
    async (origins) => {
      const response = await worker.fetch(sessionRequest("manager-token", true), {
        ADMIN_ALLOWED_ORIGINS: origins,
        ADMIN_IDENTITIES_JSON: validIdentities
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "admin_configuration_unavailable",
          message: "Admin API configuration unavailable"
        }
      });
    }
  );

  it.each([
    "{",
    JSON.stringify({ "invoice.created": [] }),
    JSON.stringify({ "invoice.created": ["latest"] })
  ])(
    "returns a redacted 503 for invalid hook schema catalog configuration: %s",
    async (catalog) => {
      const response = await worker.fetch(sessionRequest("manager-token", false), {
        ADMIN_HOOK_SCHEMA_CATALOG_JSON: catalog,
        ADMIN_IDENTITIES_JSON: validIdentities
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "admin_configuration_unavailable",
          message: "Admin API configuration unavailable"
        }
      });
    }
  );

  it("returns a redacted 503 for invalid telemetry opt-in configuration", async () => {
    const response = await worker.fetch(sessionRequest("manager-token", false), {
      ADMIN_IDENTITIES_JSON: validIdentities,
      TENANTSCRIPT_TELEMETRY_ENABLED: "true",
      TENANTSCRIPT_TELEMETRY_ENDPOINT: "http://private.invalid/events"
    });

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private.invalid");
  });
});

describe("Control Plane scheduled telemetry", () => {
  it("does not touch D1 or the network by default", async () => {
    const fetcher = vi.fn<typeof fetch>();

    await expect(runScheduledTelemetry({}, { fetcher })).resolves.toEqual({
      sent: false,
      reason: "disabled"
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends anonymous aggregates only after explicit opt-in", async () => {
    const db = aggregateDatabase();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 202 }));

    await expect(
      runScheduledTelemetry(
        {
          DB: db,
          TENANTSCRIPT_TELEMETRY_ENABLED: "true",
          TENANTSCRIPT_TELEMETRY_ENDPOINT: "https://telemetry.example.com/v1/events",
          TENANTSCRIPT_PRODUCT_VERSION: "0.0.0",
          TENANTSCRIPT_RUNTIME_PRIMITIVE: "cloudflare-workers"
        },
        { fetcher, now: () => new Date("2026-07-20T02:00:00.000Z") }
      )
    ).resolves.toEqual({ sent: true });

    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(typeof init?.body).toBe("string");
    const body = JSON.parse(init?.body as string) as unknown;
    expect(body).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-20T02:00:00.000Z",
      productVersion: "0.0.0",
      runtimePrimitive: "cloudflare-workers",
      counts: {
        enabledInstallations: 3,
        executions: 9,
        errors: { runtime: 1, timeout: 1, egressDenied: 1, budgetExceeded: 1 }
      }
    });
    expect(init?.body).not.toContain("tenant");
    expect(init?.body).not.toContain("plugin");
  });
});

function sessionRequest(token: string, includeOrigin: boolean): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (includeOrigin) {
    headers.set("Origin", "https://admin.example.com");
  }
  return new Request("https://control-plane.example.com/v1/session", { headers });
}

function aggregateDatabase(): D1DatabaseLike {
  return {
    prepare: () => {
      const statement: D1PreparedStatementLike = {
        bind: () => statement,
        run: () => Promise.reject(new Error("unexpected run")),
        first: <T>() =>
          Promise.resolve({
            enabled_installations: 3,
            executions: 9,
            runtime_errors: 1,
            timeouts: 1,
            egress_denied: 1,
            budget_exceeded: 1
          } as T),
        all: () => Promise.reject(new Error("unexpected all"))
      };
      return statement;
    }
  };
}
