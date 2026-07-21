import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1AdminProviderConnectionStore,
  createD1ControlPlaneStore,
  createD1SlackConnectionStore
} from "../src/index.js";

interface TestWorkersEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("D1 Admin provider connection inventory", () => {
  it("returns only public metadata for the authenticated tenant and app", async () => {
    const controlPlane = createD1ControlPlaneStore(testEnv.DB);
    await controlPlane.createApp({ id: "app_1", name: "App 1" });
    await controlPlane.createApp({ id: "app_other", name: "Other app" });
    await controlPlane.createTenant({ id: "tenant_1", appId: "app_1", name: "Tenant 1" });
    await controlPlane.createTenant({ id: "tenant_2", appId: "app_1", name: "Tenant 2" });
    await controlPlane.createTenant({
      id: "tenant_other",
      appId: "app_other",
      name: "Other tenant"
    });
    const slackConnections = createD1SlackConnectionStore(testEnv.DB);
    await slackConnections.upsertSlackConnection({
      id: "connection_own",
      tenantId: "tenant_1",
      workspaceId: "workspace_own",
      workspaceName: "Own workspace",
      botUserId: "bot_own",
      secretRef: {
        appId: "app_1",
        tenantId: "tenant_1",
        provider: "slack",
        secretId: "secret-own"
      },
      connectedAt: new Date("2026-07-21T00:00:00.000Z")
    });
    await slackConnections.upsertSlackConnection({
      id: "connection_own_without_optional_metadata",
      tenantId: "tenant_1",
      workspaceId: "workspace_own_without_optional_metadata",
      secretRef: {
        appId: "app_1",
        tenantId: "tenant_1",
        provider: "slack",
        secretId: "secret-own-without-optional-metadata"
      },
      connectedAt: new Date("2026-07-21T00:30:00.000Z")
    });
    await slackConnections.upsertSlackConnection({
      id: "connection_own_with_blank_optional_metadata",
      tenantId: "tenant_1",
      workspaceId: "workspace_own_with_blank_optional_metadata",
      workspaceName: "",
      botUserId: "",
      secretRef: {
        appId: "app_1",
        tenantId: "tenant_1",
        provider: "slack",
        secretId: "secret-own-with-blank-optional-metadata"
      },
      connectedAt: new Date("2026-07-21T00:45:00.000Z")
    });
    await slackConnections.upsertSlackConnection({
      id: "connection_other_tenant",
      tenantId: "tenant_2",
      workspaceId: "workspace_other_tenant",
      secretRef: {
        appId: "app_1",
        tenantId: "tenant_2",
        provider: "slack",
        secretId: "secret-other-tenant"
      },
      connectedAt: new Date("2026-07-21T01:00:00.000Z")
    });
    await slackConnections.upsertSlackConnection({
      id: "connection_other_app",
      tenantId: "tenant_other",
      workspaceId: "workspace_other_app",
      secretRef: {
        appId: "app_other",
        tenantId: "tenant_other",
        provider: "slack",
        secretId: "secret-other-app"
      },
      connectedAt: new Date("2026-07-21T02:00:00.000Z")
    });

    const inventory = createD1AdminProviderConnectionStore(testEnv.DB);
    const result = await inventory.readConnections({ appId: "app_1", tenantId: "tenant_1" });

    expect(result).toEqual([
      {
        provider: "slack",
        id: "connection_own_with_blank_optional_metadata",
        workspaceId: "workspace_own_with_blank_optional_metadata",
        connectedAt: "2026-07-21T00:45:00.000Z"
      },
      {
        provider: "slack",
        id: "connection_own_without_optional_metadata",
        workspaceId: "workspace_own_without_optional_metadata",
        connectedAt: "2026-07-21T00:30:00.000Z"
      },
      {
        provider: "slack",
        id: "connection_own",
        workspaceId: "workspace_own",
        workspaceName: "Own workspace",
        botUserId: "bot_own",
        connectedAt: "2026-07-21T00:00:00.000Z"
      }
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("secret-own");
    expect(serialized).not.toContain("workspace_other");

    await expect(
      inventory.readConnections({ appId: "app_other", tenantId: "tenant_1" })
    ).resolves.toEqual([]);
  });
});
