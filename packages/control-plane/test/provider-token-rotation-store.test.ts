import { describe, expect, it, vi } from "vitest";
import {
  createInMemorySecretStore,
  createProviderTokenRotationManager,
  type SecretRef,
  type SecretStore
} from "../src/index.js";

const ref: SecretRef = {
  provider: "github",
  tenantId: "tenant_1",
  secretId: "provider-token-set:installation_1"
};

describe("encrypted provider token rotation manager", () => {
  it("stages, promotes, rolls back, and finalizes without returning raw tokens from mutations", async () => {
    const secretStore = createInMemorySecretStore();
    const manager = createProviderTokenRotationManager({ secretStore, ref });

    await expect(manager.initialize({ id: "github-v1", value: "active-secret" })).resolves.toEqual({
      activeTokenId: "github-v1"
    });
    await expect(manager.resolveTokens()).resolves.toEqual({
      active: { id: "github-v1", value: "active-secret" }
    });

    await expect(
      manager.stageCandidate({ id: "github-v2", value: "candidate-secret" })
    ).resolves.toEqual({
      activeTokenId: "github-v1",
      candidateTokenId: "github-v2"
    });
    await expect(manager.resolveTokens()).resolves.toEqual({
      active: { id: "github-v1", value: "active-secret" },
      candidate: { id: "github-v2", value: "candidate-secret" }
    });

    await expect(manager.promoteCandidate("github-v2")).resolves.toEqual({
      activeTokenId: "github-v2",
      retiringTokenId: "github-v1"
    });
    await expect(manager.resolveTokens()).resolves.toEqual({
      active: { id: "github-v2", value: "candidate-secret" }
    });

    await expect(manager.rollbackToRetiring("github-v1")).resolves.toEqual({
      activeTokenId: "github-v1",
      retiringTokenId: "github-v2"
    });
    await expect(manager.finalizeRetiring("github-v2")).resolves.toEqual({
      activeTokenId: "github-v1"
    });
    expect(JSON.stringify(await manager.inspect())).not.toContain("secret");
  });

  it("aborts a staged candidate without changing the active token", async () => {
    const manager = createProviderTokenRotationManager({
      secretStore: createInMemorySecretStore(),
      ref
    });
    await manager.initialize({ id: "github-v1", value: "active-secret" });
    await manager.stageCandidate({ id: "github-v2", value: "candidate-secret" });

    await expect(manager.abortCandidate("github-v2")).resolves.toEqual({
      activeTokenId: "github-v1"
    });
    await expect(manager.resolveTokens()).resolves.toEqual({
      active: { id: "github-v1", value: "active-secret" }
    });
  });

  it("fails one conflicting transition without retrying or losing the winning state", async () => {
    const baseStore = createInMemorySecretStore();
    const setup = createProviderTokenRotationManager({ secretStore: baseStore, ref });
    await setup.initialize({ id: "github-v1", value: "active-secret" });
    const compareAndSwapSecret = vi.fn(() => Promise.resolve({ matched: false, changed: false }));
    const conflictStore: SecretStore = { ...baseStore, compareAndSwapSecret };
    const manager = createProviderTokenRotationManager({ secretStore: conflictStore, ref });

    await expect(
      manager.stageCandidate({ id: "github-v2", value: "candidate-secret" })
    ).rejects.toThrow("provider token state changed concurrently");
    expect(compareAndSwapSecret).toHaveBeenCalledOnce();
    await expect(setup.resolveTokens()).resolves.toEqual({
      active: { id: "github-v1", value: "active-secret" }
    });
  });

  it.each([
    [
      "promote without candidate",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.promoteCandidate("github-v2")
    ],
    [
      "rollback without retiring",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.rollbackToRetiring("github-v0")
    ],
    [
      "finalize without retiring",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.finalizeRetiring("github-v0")
    ],
    [
      "abort without candidate",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.abortCandidate("github-v2")
    ],
    [
      "duplicate active id",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.stageCandidate({ id: "github-v1", value: "candidate-secret" })
    ],
    [
      "oversized token",
      (manager: ReturnType<typeof createProviderTokenRotationManager>) =>
        manager.stageCandidate({ id: "github-v2", value: "x".repeat(16_385) })
    ]
  ])("rejects an invalid transition: %s", async (_name, transition) => {
    const manager = createProviderTokenRotationManager({
      secretStore: createInMemorySecretStore(),
      ref
    });
    await manager.initialize({ id: "github-v1", value: "active-secret" });

    let caught: unknown;
    try {
      await transition(manager);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("provider token transition is invalid");
    expect((caught as Error).message).not.toContain("candidate-secret");
  });

  it.each([
    ["missing token value", '{"version":1,"active":{"id":"x"}}'],
    ["unknown version", '{"version":2,"active":{"id":"x","value":"secret-v1"}}'],
    [
      "unknown field",
      '{"version":1,"active":{"id":"x","value":"secret-v1"},"debug":"secret-debug"}'
    ],
    [
      "duplicate token id",
      '{"version":1,"active":{"id":"x","value":"secret-v1"},"candidate":{"id":"x","value":"secret-v2"}}'
    ],
    [
      "candidate and retiring together",
      '{"version":1,"active":{"id":"x","value":"secret-v1"},"candidate":{"id":"y","value":"secret-v2"},"retiring":{"id":"z","value":"secret-v0"}}'
    ]
  ])("fails closed on malformed encrypted state: %s", async (_name, serializedState) => {
    const secretStore = createInMemorySecretStore();
    await secretStore.putSecret({ ref, value: serializedState });
    const manager = createProviderTokenRotationManager({ secretStore, ref });

    let caught: unknown;
    try {
      await manager.resolveTokens();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("provider token state is invalid");
    expect((caught as Error).message).not.toContain("secret");
  });
});
