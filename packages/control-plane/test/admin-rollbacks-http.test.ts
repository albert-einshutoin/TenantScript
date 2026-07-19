import { describe, expect, it, vi } from "vitest";
import {
  AdminRollbackError,
  createControlPlaneHttpHandler,
  createStaticTokenIdentityResolver,
  type AdminRollbackStore
} from "../src/index.js";

describe("Control Plane Admin rollback HTTP contract", () => {
  it("requires a bounded key and rejects changed key reuse without reflecting details", async () => {
    const store = rollbackStore();
    store.rollback.mockRejectedValueOnce(new AdminRollbackError("idempotency_key_reused"));
    const handler = createHandler(store);
    const missing = new Request("https://api.example.com/v1/admin/rollbacks", {
      method: "POST",
      headers: { Authorization: "Bearer manager", "Content-Type": "application/json" },
      body: JSON.stringify(validBody())
    });
    expect((await handler(missing)).status).toBe(400);

    const conflict = await handler(request("manager", validBody()));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: { code: "idempotency_key_reused", message: "idempotency key was already used" }
    });
  });

  it("derives scope and actor from the manager identity", async () => {
    const store = rollbackStore();
    const handler = createHandler(store);

    const response = await handler(request("manager", validBody()));

    expect(response.status).toBe(200);
    expect(store.rollback).toHaveBeenCalledWith({
      appId: "app_acme",
      tenantId: "tenant_acme",
      actor: "manager-subject",
      idempotencyKey: "rollback-http-key-0001",
      installationId: "installation_1",
      targetVersionId: "version_1_2_2",
      expectedRevision: 3
    });
    await expect(response.json()).resolves.toEqual({
      installationId: "installation_1",
      pluginKey: "invoice-notify",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 4,
      auditId: "audit_rollback_1",
      completedAt: "2026-07-19T17:00:00.000Z"
    });
  });

  it("forbids viewers and rejects self-asserted scope or malformed commands", async () => {
    const store = rollbackStore();
    const handler = createHandler(store);

    expect((await handler(request("viewer", validBody()))).status).toBe(403);
    for (const body of [
      { ...validBody(), tenantId: "tenant_other" },
      { ...validBody(), actor: "attacker" },
      { ...validBody(), expectedRevision: -1 },
      { ...validBody(), expectedRevision: 1.5 },
      { ...validBody(), targetVersionId: "" }
    ]) {
      expect((await handler(request("manager", body))).status).toBe(400);
    }
    expect(store.rollback).not.toHaveBeenCalled();
  });

  it("uses stable common errors for missing, stale, and current-version targets", async () => {
    const store = rollbackStore();
    store.rollback
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ outcome: "conflict", installationId: "installation_1", revision: 4 })
      .mockResolvedValueOnce({
        outcome: "same_version",
        installationId: "installation_1",
        revision: 4
      });
    const handler = createHandler(store);

    const missing = await handler(request("manager", validBody()));
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "rollback_target_not_found" }
    });

    const conflict = await handler(request("manager", validBody()));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "installation_revision_conflict" }
    });

    const same = await handler(request("manager", validBody()));
    expect(same.status).toBe(409);
    await expect(same.json()).resolves.toMatchObject({
      error: { code: "rollback_target_is_current" }
    });
  });
});

function createHandler(store: ReturnType<typeof rollbackStore>) {
  return createControlPlaneHttpHandler({
    identityResolver: createStaticTokenIdentityResolver({
      manager: {
        subject: "manager-subject",
        role: "manager",
        appId: "app_acme",
        tenantId: "tenant_acme"
      },
      viewer: {
        subject: "viewer-subject",
        role: "viewer",
        appId: "app_acme",
        tenantId: "tenant_acme"
      }
    }),
    rollbackStore: store,
    adminMutationRateLimiter: allowAdminMutation
  });
}

const allowAdminMutation = {
  reserve: () => Promise.resolve({ allowed: true as const, remaining: 999 })
};

function rollbackStore() {
  return {
    rollback: vi.fn<AdminRollbackStore["rollback"]>().mockResolvedValue({
      outcome: "rolled_back",
      installationId: "installation_1",
      pluginKey: "invoice-notify",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 4,
      auditId: "audit_rollback_1",
      completedAt: "2026-07-19T17:00:00.000Z"
    })
  } satisfies AdminRollbackStore;
}

function validBody(): Record<string, unknown> {
  return {
    installationId: "installation_1",
    targetVersionId: "version_1_2_2",
    expectedRevision: 3
  };
}

function request(token: string, body: Record<string, unknown>): Request {
  return new Request("https://api.example.com/v1/admin/rollbacks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "rollback-http-key-0001"
    },
    body: JSON.stringify(body)
  });
}
