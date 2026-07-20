import { describe, expect, it, vi } from "vitest";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/index.js";
import worker, {
  runScheduledExecutionRetention,
  runScheduledTelemetry,
  scheduleMaintenanceTasks
} from "../src/worker-entry.js";

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

  it("selects the authenticated app database before constructing tenant stores", async () => {
    const appDatabase = failingDatabase("selected app database");
    const compatibilityDatabase = failingDatabase("compatibility database");

    const response = await worker.fetch(adminRequest("manager-token"), {
      ADMIN_CURSOR_SECRET: "worker-routing-test-secret-with-32-bytes",
      ADMIN_IDENTITIES_JSON: validIdentities,
      APP_DATABASE_ROUTES_JSON: JSON.stringify({ app_1: "APP_ONE_DB" }),
      APP_ONE_DB: appDatabase.database,
      DB: compatibilityDatabase.database
    });

    expect(response.status).toBe(500);
    expect(appDatabase.prepare).toHaveBeenCalled();
    expect(compatibilityDatabase.prepare).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("selected app database");
  });

  it("wires the provider connection inventory to the authenticated app database", async () => {
    const all = vi.fn().mockResolvedValue({
      results: [
        {
          id: "connection_1",
          workspace_id: "T123",
          workspace_name: "Acme Operations",
          bot_user_id: "B123",
          connected_at: "2026-07-21T00:00:00.000Z"
        }
      ]
    });
    const statement: D1PreparedStatementLike = {
      bind: vi.fn(() => statement),
      all,
      first: vi.fn(() => Promise.resolve(null)),
      run: vi.fn(() => Promise.reject(new Error("unexpected run")))
    };
    const prepare = vi.fn(() => statement);
    const request = new Request("https://control-plane.example.com/v1/admin/provider-connections", {
      headers: { Authorization: "Bearer manager-token" }
    });

    const response = await worker.fetch(request, {
      ADMIN_IDENTITIES_JSON: validIdentities,
      APP_DATABASE_ROUTES_JSON: JSON.stringify({ app_1: "APP_ONE_DB" }),
      APP_ONE_DB: { prepare }
    });

    expect(response.status).toBe(200);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM slack_connections"));
    expect(prepare).not.toHaveBeenCalledWith(expect.stringContaining("secret_ref_json"));
    expect(statement.bind).toHaveBeenCalledWith("tenant_1", "app_1");
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          provider: "slack",
          id: "connection_1",
          workspaceId: "T123",
          workspaceName: "Acme Operations",
          botUserId: "B123",
          connectedAt: "2026-07-21T00:00:00.000Z"
        }
      ]
    });
  });

  it("fails closed without touching D1 when the authenticated app is not provisioned", async () => {
    const appDatabase = failingDatabase("other app database");
    const compatibilityDatabase = failingDatabase("compatibility database");

    const response = await worker.fetch(adminRequest("manager-token"), {
      ADMIN_CURSOR_SECRET: "worker-routing-test-secret-with-32-bytes",
      ADMIN_IDENTITIES_JSON: validIdentities,
      APP_DATABASE_ROUTES_JSON: JSON.stringify({ app_2: "APP_TWO_DB" }),
      APP_TWO_DB: appDatabase.database,
      DB: compatibilityDatabase.database
    });

    expect(response.status).toBe(503);
    expect(appDatabase.prepare).not.toHaveBeenCalled();
    expect(compatibilityDatabase.prepare).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "app_database_unavailable",
        message: "App database unavailable"
      }
    });
  });

  it("rejects an unauthenticated sharded request before touching any database", async () => {
    const appDatabase = failingDatabase("app database");
    const authenticationDatabase = failingDatabase("authentication database");

    const response = await worker.fetch(adminRequest("unknown-token"), {
      ADMIN_CURSOR_SECRET: "worker-routing-test-secret-with-32-bytes",
      ADMIN_IDENTITIES_JSON: validIdentities,
      APP_DATABASE_ROUTES_JSON: JSON.stringify({ app_1: "APP_ONE_DB" }),
      APP_ONE_DB: appDatabase.database,
      DB: authenticationDatabase.database
    });

    expect(response.status).toBe(401);
    expect(appDatabase.prepare).not.toHaveBeenCalled();
    expect(authenticationDatabase.prepare).not.toHaveBeenCalled();
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
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

describe("Control Plane scheduled execution retention", () => {
  it("is disabled without an explicit policy and does not touch storage", async () => {
    const prepare = vi.fn(() => {
      throw new Error("D1 must not be touched");
    });

    await expect(
      runScheduledExecutionRetention({ DB: { prepare }, EXECUTION_ARCHIVE: archiveBucket() })
    ).resolves.toEqual({ archivedScopes: 0, scannedScopes: 0, status: "disabled" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("archives one bounded batch per stable tenant scope", async () => {
    const scopes = Array.from({ length: 51 }, (_, index) => ({
      app_id: `app_${String(index).padStart(2, "0")}`,
      id: `tenant_${String(index).padStart(2, "0")}`
    }));
    const all = vi.fn().mockResolvedValue({ results: scopes });
    const statement: D1PreparedStatementLike = {
      bind: vi.fn(() => statement),
      all,
      first: vi.fn(() => Promise.resolve(null)),
      run: vi.fn(() => Promise.resolve(null))
    };
    const prepare = vi.fn(() => statement);
    const archiveScope = vi.fn().mockResolvedValue(indexedManifest());
    const now = new Date("2026-07-20T02:00:00.000Z");

    await expect(
      runScheduledExecutionRetention(
        {
          DB: { prepare },
          EXECUTION_ARCHIVE: archiveBucket(),
          EXECUTION_ARCHIVE_HOT_RETENTION_DAYS: "30"
        },
        { archiveScope, now: () => now }
      )
    ).resolves.toEqual({ archivedScopes: 50, scannedScopes: 50, status: "completed" });

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("WHERE EXISTS"));
    expect(statement.bind).toHaveBeenCalledWith("2026-06-20T02:00:00.000Z", 50);
    expect(archiveScope).toHaveBeenCalledTimes(50);
    expect(archiveScope).toHaveBeenNthCalledWith(1, {
      appId: "app_00",
      tenantId: "tenant_00",
      now
    });
    expect(archiveScope).not.toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant_50" })
    );
  });

  it.each(["0", "1.5", "3651", "secret-sentinel"])(
    "rejects unsafe retention configuration before storage access: %s",
    async (hotRetentionDays) => {
      const prepare = vi.fn();
      await expect(
        runScheduledExecutionRetention({
          DB: { prepare },
          EXECUTION_ARCHIVE: archiveBucket(),
          EXECUTION_ARCHIVE_HOT_RETENTION_DAYS: hotRetentionDays
        })
      ).rejects.toThrow("execution retention configuration is invalid");
      expect(prepare).not.toHaveBeenCalled();
    }
  );

  it("fails closed when an explicit policy is missing its R2 binding", async () => {
    const prepare = vi.fn();

    await expect(
      runScheduledExecutionRetention({
        DB: { prepare },
        EXECUTION_ARCHIVE_HOT_RETENTION_DAYS: "30"
      })
    ).rejects.toThrow("execution retention configuration is invalid");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an invalid schedule time before reading tenant scopes", async () => {
    const prepare = vi.fn();

    await expect(
      runScheduledExecutionRetention(
        {
          DB: { prepare },
          EXECUTION_ARCHIVE: archiveBucket(),
          EXECUTION_ARCHIVE_HOT_RETENTION_DAYS: "30"
        },
        { now: () => new Date(Number.NaN) }
      )
    ).rejects.toThrow("execution retention configuration is invalid");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("starts telemetry and retention independently while preserving failure visibility", async () => {
    const telemetryRunner = vi.fn().mockRejectedValue(new Error("telemetry unavailable"));
    const retentionRunner = vi.fn().mockResolvedValue({ status: "disabled" });
    const tasks: Promise<unknown>[] = [];

    scheduleMaintenanceTasks({}, (task) => tasks.push(task), {
      retentionRunner,
      telemetryRunner
    });
    await expect(Promise.allSettled(tasks)).resolves.toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "fulfilled" })
    ]);
    expect(telemetryRunner).toHaveBeenCalledOnce();
    expect(retentionRunner).toHaveBeenCalledOnce();
  });
});

function sessionRequest(token: string, includeOrigin: boolean): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (includeOrigin) {
    headers.set("Origin", "https://admin.example.com");
  }
  return new Request("https://control-plane.example.com/v1/session", { headers });
}

function adminRequest(token: string): Request {
  return new Request("https://control-plane.example.com/v1/admin/dashboard/installations", {
    headers: { Authorization: `Bearer ${token}` }
  });
}

function failingDatabase(message: string) {
  const prepare = vi.fn(() => {
    throw new Error(message);
  });
  return { database: { prepare } satisfies D1DatabaseLike, prepare };
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

function archiveBucket() {
  return {
    get: vi.fn(),
    head: vi.fn(),
    put: vi.fn()
  };
}

function indexedManifest() {
  return { id: "archive" };
}
