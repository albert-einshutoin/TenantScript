import { describe, expect, it, vi } from "vitest";
import {
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminRollbackStore
} from "../src/index.js";

const allowedOrigin = "https://admin.example.com";

describe("Control Plane HTTP RBAC enforcement", () => {
  it.each(["owner", "admin", "operator", "viewer", "tenant-admin", "manager"])(
    "accepts the supported %s identity for a tenant-scoped session",
    async (role) => {
      const handler = handlerFor(role);

      const response = await handler(request(role, "/v1/session"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ role });
    }
  );

  it.each([
    ["owner", 200],
    ["admin", 200],
    ["operator", 403],
    ["viewer", 403],
    ["tenant-admin", 200],
    ["manager", 200]
  ])("applies the matrix to rollback for %s", async (role, expectedStatus) => {
    const rollback = vi.fn<AdminRollbackStore["rollback"]>().mockResolvedValue({
      outcome: "rolled_back",
      installationId: "inst_1",
      pluginKey: "plugin",
      fromVersion: "2.0.0",
      toVersion: "1.0.0",
      revision: 2,
      auditId: "audit_1",
      completedAt: "2026-07-20T00:00:00.000Z"
    });
    const handler = handlerFor(role, { rollback });

    const response = await handler(
      request(role, "/v1/admin/rollbacks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `rbac-${role}-rollback-key-0001`
        },
        body: JSON.stringify({
          installationId: "inst_1",
          targetVersionId: "version_1",
          expectedRevision: 1
        })
      })
    );

    expect(response.status).toBe(expectedStatus);
    expect(rollback).toHaveBeenCalledTimes(expectedStatus === 200 ? 1 : 0);
  });
});

function handlerFor(role: string, rollbackStore?: AdminRollbackStore) {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      [role]: { subject: `${role}-subject`, role, appId: "app_1", tenantId: "tenant_1" }
    }),
    ...(rollbackStore === undefined ? {} : { rollbackStore }),
    adminMutationRateLimiter: {
      reserve: () => Promise.resolve({ allowed: true, remaining: 1 })
    },
    allowedOrigins: [allowedOrigin]
  });
}

function request(role: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${role}`);
  headers.set("Origin", allowedOrigin);
  return new Request(`https://api.example.com${path}`, { ...init, headers });
}
