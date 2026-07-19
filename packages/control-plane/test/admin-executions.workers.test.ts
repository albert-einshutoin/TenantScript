import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminDashboardStore,
  createD1AdminExecutionDetailStore,
  createD1ControlPlaneStore
} from "../src/index.js";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_1", name: "App 1" });
  await store.createApp({ id: "app_other", name: "Other" });
  await store.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
  await store.createTenant({ id: "tenant_other", appId: "app_other", name: "Other" });
  await store.createPlugin({ id: "plugin_1", appId: "app_1", key: "invoice-notify" });
  await store.createPlugin({ id: "plugin_2", appId: "app_1", key: "transformer" });
  await store.createPlugin({ id: "plugin_other", appId: "app_other", key: "other" });
  await store.writeExecution(
    execution({ id: "exec_match", tenantId: "tenant_1", pluginId: "plugin_1", status: "error" })
  );
  await store.writeExecution(
    execution({
      id: "exec_other_filter",
      tenantId: "tenant_1",
      pluginId: "plugin_2",
      hookName: "webhook.outbound",
      status: "success"
    })
  );
  await store.writeExecution(
    execution({
      id: "exec_other_tenant",
      tenantId: "tenant_other",
      pluginId: "plugin_other",
      status: "error",
      error: "other tenant customer payload"
    })
  );
});

describe("D1 Admin execution search", () => {
  it("filters before pagination and keeps other tenant records outside the result", async () => {
    const dashboard = createD1AdminDashboardStore(testEnv.DB);
    const result = await dashboard.readSection({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "executions",
      limit: 10,
      filters: { pluginId: "plugin_1", hookName: "invoice.created", status: "error" }
    });

    expect(result.items).toEqual([
      expect.objectContaining({ id: "exec_match", pluginId: "plugin_1", status: "error" })
    ]);
    expect(JSON.stringify(result)).not.toContain("exec_other_filter");
    expect(JSON.stringify(result)).not.toContain("exec_other_tenant");
  });

  it("returns safe detail and common nulls across tenant/app boundaries", async () => {
    const details = createD1AdminExecutionDetailStore(testEnv.DB);
    const own = await details.readExecution({
      appId: "app_1",
      tenantId: "tenant_1",
      id: "exec_match"
    });
    expect(own).toMatchObject({
      id: "exec_match",
      errorCode: "execution_failed",
      capabilityCalls: [{ name: "slack.send", status: "error" }]
    });
    expect(JSON.stringify(own)).not.toContain("provider secret");
    await expect(
      details.readExecution({ appId: "app_1", tenantId: "tenant_1", id: "exec_other_tenant" })
    ).resolves.toBeNull();
    await expect(
      details.readExecution({ appId: "app_other", tenantId: "tenant_1", id: "exec_match" })
    ).resolves.toBeNull();
  });
});

function execution(overrides: {
  id: string;
  tenantId: string;
  pluginId: string;
  hookName?: string;
  status: "success" | "error";
  error?: string;
}) {
  return {
    id: overrides.id,
    tenantId: overrides.tenantId,
    pluginId: overrides.pluginId,
    hookName: overrides.hookName ?? "invoice.created",
    version: "1.0.0",
    status: overrides.status,
    durationMs: 21,
    ...(overrides.error === undefined
      ? { error: "provider secret and customer payload" }
      : { error: overrides.error }),
    capabilityCalls: [
      {
        name: "slack.send",
        status: overrides.status === "error" ? ("error" as const) : ("success" as const)
      }
    ],
    createdAt: new Date("2026-07-19T00:00:00.000Z")
  };
}
