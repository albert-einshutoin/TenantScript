import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDurableObjectNamespaceSecretStore } from "../src/index.js";
import {
  createSlackCredentialLifecycleManager,
  initializeSlackCredentialLifecycle
} from "../src/slack-credential-lifecycle.js";

interface TestWorkersEnv {
  PROVIDER_SECRET_STORE_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestWorkersEnv;
const ref = {
  provider: "slack",
  appId: "app_worker",
  tenantId: "tenant_worker",
  secretId: "slack:T_WORKER"
};

beforeEach(async () => reset());

describe("Slack credential lifecycle on the production secret Durable Object", () => {
  it("allows only one provider call across concurrent refresh requests", async () => {
    const secretStore = createDurableObjectNamespaceSecretStore(testEnv.PROVIDER_SECRET_STORE_DO);
    await initializeSlackCredentialLifecycle({
      secretStore,
      ref,
      accessToken: "xoxe.xoxb-1-worker-access",
      refreshToken: "xoxe-1-worker-refresh",
      expiresIn: 3_600,
      issuedAt: new Date("2026-07-21T00:00:00.000Z")
    });
    const refresh = vi.fn().mockResolvedValue({
      accessToken: "xoxe.xoxb-2-worker-access",
      refreshToken: "xoxe-2-worker-refresh",
      expiresIn: 43_200
    });
    const options = {
      secretStore,
      ref,
      refreshClient: { refresh },
      now: () => new Date("2026-07-21T00:56:00.000Z"),
      refreshSkewMs: 5 * 60_000,
      maxJitterMs: 0
    };

    const results = await Promise.all([
      createSlackCredentialLifecycleManager(options).refreshIfDue(),
      createSlackCredentialLifecycleManager(options).refreshIfDue()
    ]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.refreshed)).toHaveLength(1);
    await expect(createSlackCredentialLifecycleManager(options).inspect()).resolves.toMatchObject({
      status: "ready",
      generation: 2
    });
  });
});
