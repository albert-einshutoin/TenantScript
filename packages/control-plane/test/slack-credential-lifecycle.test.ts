import { describe, expect, it, vi } from "vitest";
import {
  createInMemorySecretStore,
  type SecretRef,
  type SecretStore,
  type SlackTokenRefreshClient
} from "../src/index.js";
import {
  createSlackCredentialLifecycleManager,
  initializeSlackCredentialLifecycle,
  SlackCredentialLifecycleError
} from "../src/slack-credential-lifecycle.js";

const ref: SecretRef = {
  provider: "slack",
  appId: "app_1",
  tenantId: "tenant_1",
  secretId: "slack:T123"
};

describe("Slack credential lifecycle", () => {
  it("rejects unsafe refresh timing configuration", async () => {
    const secretStore = await initializedStore();

    expect(() =>
      createSlackCredentialLifecycleManager({
        secretStore,
        ref,
        refreshClient: { refresh: vi.fn() },
        refreshSkewMs: -1
      })
    ).toThrow(new SlackCredentialLifecycleError("slack_credential_state_invalid"));
  });

  it("refreshes a due credential once and durably advances its generation", async () => {
    const secretStore = createInMemorySecretStore();
    await initializeSlackCredentialLifecycle({
      secretStore,
      ref,
      accessToken: "xoxe.xoxb-1-access",
      refreshToken: "xoxe-1-refresh",
      expiresIn: 3_600,
      issuedAt: new Date("2026-07-21T00:00:00.000Z")
    });
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "xoxe.xoxb-2-access",
      refreshToken: "xoxe-2-refresh",
      expiresIn: 43_200
    });
    const manager = createSlackCredentialLifecycleManager({
      secretStore,
      ref,
      refreshClient: { refresh },
      now: () => new Date("2026-07-21T00:56:00.000Z"),
      refreshSkewMs: 5 * 60_000,
      maxJitterMs: 0
    });

    const refreshResult = await manager.refreshIfDue();
    expect(refreshResult.tokenId).toMatch(/^slack_[A-Za-z0-9_-]{16}$/u);
    expect(refreshResult).toEqual({
      status: "ready",
      generation: 2,
      tokenId: refreshResult.tokenId,
      expiresAt: "2026-07-21T12:56:00.000Z",
      refreshed: true
    });
    await expect(manager.resolveAccessToken()).resolves.toBe("xoxe.xoxb-2-access");
    const inspection = await manager.inspect();
    expect(inspection.tokenId).toMatch(/^slack_[A-Za-z0-9_-]{16}$/u);
    expect(inspection).toEqual({
      status: "ready",
      generation: 2,
      tokenId: inspection.tokenId,
      expiresAt: "2026-07-21T12:56:00.000Z"
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("xoxe-1-refresh");
    await expect(manager.refreshIfDue()).resolves.toMatchObject({
      generation: 2,
      refreshed: false
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale generation before provider access", async () => {
    const base = await initializedStore();
    let injected = false;
    const secretStore: SecretStore = {
      ...base,
      compareAndSwapSecret: async (request) => {
        if (!injected) {
          injected = true;
          const newer = JSON.parse(request.expectedValue as string) as Record<string, unknown>;
          newer.generation = 2;
          await base.putSecret({ ref: request.ref, value: JSON.stringify(newer) });
        }
        return base.compareAndSwapSecret(request);
      }
    };
    const refresh = vi.fn<SlackTokenRefreshClient["refresh"]>();
    const manager = dueManager(secretStore, refresh);

    await expect(manager.refreshIfDue()).resolves.toMatchObject({
      status: "ready",
      generation: 2,
      refreshed: false
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("uses CAS as a single-writer gate for concurrent refresh attempts", async () => {
    const secretStore = await initializedStore();
    let release:
      | ((value: { accessToken: string; refreshToken: string; expiresIn: number }) => void)
      | undefined;
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const options = {
      secretStore,
      ref,
      refreshClient: { refresh },
      now: () => new Date("2026-07-21T00:56:00.000Z"),
      refreshSkewMs: 5 * 60_000,
      maxJitterMs: 0
    };
    const first = createSlackCredentialLifecycleManager(options).refreshIfDue();
    const second = createSlackCredentialLifecycleManager(options).refreshIfDue();
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    release?.({
      accessToken: "xoxe.xoxb-2-access",
      refreshToken: "xoxe-2-refresh",
      expiresIn: 43_200
    });

    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.refreshed)).toHaveLength(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("marks ambiguous provider outcomes for operator intervention without retry", async () => {
    const secretStore = await initializedStore();
    const refresh = vi.fn().mockRejectedValue(new Error("ambiguous provider result secret"));
    const manager = dueManager(secretStore, refresh);

    await expect(manager.refreshIfDue()).rejects.toEqual(
      new SlackCredentialLifecycleError("slack_credential_intervention_required")
    );
    const inspection = await manager.inspect();
    expect(inspection.tokenId).toMatch(/^slack_[A-Za-z0-9_-]{16}$/u);
    expect(inspection).toEqual({
      status: "intervention_required",
      generation: 1,
      tokenId: inspection.tokenId,
      expiresAt: "2026-07-21T01:00:00.000Z"
    });
    await expect(manager.resolveAccessToken()).rejects.toMatchObject({
      code: "slack_credential_intervention_required"
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the prior access token usable while one refresh is in flight", async () => {
    const secretStore = await initializedStore();
    let release:
      | ((value: { accessToken: string; refreshToken: string; expiresIn: number }) => void)
      | undefined;
    const refresh = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const manager = dueManager(secretStore, refresh);
    const pending = manager.refreshIfDue();
    await vi.waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    await expect(manager.resolveAccessToken()).resolves.toBe("xoxe.xoxb-1-access");
    release?.({
      accessToken: "xoxe.xoxb-2-access",
      refreshToken: "xoxe-2-refresh",
      expiresIn: 43_200
    });
    await pending;
  });

  it("fails closed when the replacement cannot be persisted", async () => {
    const base = await initializedStore();
    let writes = 0;
    const secretStore: SecretStore = {
      ...base,
      compareAndSwapSecret: async (request) => {
        writes += 1;
        if (writes === 2) throw new Error("synthetic storage failure secret");
        return base.compareAndSwapSecret(request);
      }
    };
    const manager = dueManager(
      secretStore,
      vi.fn().mockResolvedValue({
        accessToken: "xoxe.xoxb-2-access",
        refreshToken: "xoxe-2-refresh",
        expiresIn: 43_200
      })
    );

    await expect(manager.refreshIfDue()).rejects.toMatchObject({
      code: "slack_credential_intervention_required"
    });
    await expect(manager.inspect()).resolves.toMatchObject({ status: "intervention_required" });
  });

  it("rejects an invalid provider replacement and does not replay its refresh token", async () => {
    const secretStore = await initializedStore();
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "xoxe.xoxb-invalid-access",
      refreshToken: "xoxe-invalid-refresh",
      expiresIn: 0
    });
    const manager = dueManager(secretStore, refresh);

    await expect(manager.refreshIfDue()).rejects.toMatchObject({
      code: "slack_credential_intervention_required"
    });
    await expect(manager.refreshIfDue()).rejects.toMatchObject({
      code: "slack_credential_intervention_required"
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("denies expired access credentials with a stable token-free error", async () => {
    const secretStore = await initializedStore();
    const manager = createSlackCredentialLifecycleManager({
      secretStore,
      ref,
      refreshClient: { refresh: vi.fn() },
      now: () => new Date("2026-07-21T01:00:00.000Z"),
      maxJitterMs: 0
    });

    const failure = await captureFailure(manager.resolveAccessToken());
    expect(failure).toEqual(new SlackCredentialLifecycleError("slack_credential_expired"));
    expect(JSON.stringify(failure)).not.toContain("xoxe");
  });
});

async function initializedStore(): Promise<ReturnType<typeof createInMemorySecretStore>> {
  const secretStore = createInMemorySecretStore();
  await initializeSlackCredentialLifecycle({
    secretStore,
    ref,
    accessToken: "xoxe.xoxb-1-access",
    refreshToken: "xoxe-1-refresh",
    expiresIn: 3_600,
    issuedAt: new Date("2026-07-21T00:00:00.000Z")
  });
  return secretStore;
}

async function captureFailure(value: Promise<unknown>): Promise<unknown> {
  try {
    await value;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected failure");
}

function dueManager(
  secretStore: SecretStore,
  refresh: SlackTokenRefreshClient["refresh"]
): ReturnType<typeof createSlackCredentialLifecycleManager> {
  return createSlackCredentialLifecycleManager({
    secretStore,
    ref,
    refreshClient: { refresh },
    now: () => new Date("2026-07-21T00:56:00.000Z"),
    refreshSkewMs: 5 * 60_000,
    maxJitterMs: 0
  });
}
