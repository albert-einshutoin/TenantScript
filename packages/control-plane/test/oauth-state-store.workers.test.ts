import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDurableObjectNamespaceOAuthStateStore, OAuthStateStoreError } from "../src/index.js";

interface TestWorkersEnv {
  OAUTH_STATE_STORE_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestWorkersEnv;
const browserBinding = "browser_session_abcdefghijklmnopqrstuvwxyz012345";

beforeEach(async () => {
  await reset();
});

describe("production OAuth state store Durable Object", () => {
  it("persists only digests and consumes a bound state once", async () => {
    const store = createDurableObjectNamespaceOAuthStateStore(testEnv.OAUTH_STATE_STORE_DO);
    const issued = await store.issue({
      provider: "slack",
      appId: "app_worker",
      tenantId: "tenant_worker",
      actorSubject: "manager_worker",
      browserBinding,
      redirectUri: "https://admin.example.test/oauth/slack/callback"
    });
    const stub = testEnv.OAUTH_STATE_STORE_DO.get(
      testEnv.OAUTH_STATE_STORE_DO.idFromName(await shardName(issued.state))
    );
    const persisted = await runInDurableObject(stub, (_instance, state) => state.storage.list());

    expect(JSON.stringify([...persisted.entries()])).not.toContain(issued.state);
    expect(JSON.stringify([...persisted.entries()])).not.toContain(browserBinding);
    await expect(store.consume({ state: issued.state, browserBinding })).resolves.toMatchObject({
      appId: "app_worker",
      tenantId: "tenant_worker",
      actorSubject: "manager_worker"
    });
    await expect(store.consume({ state: issued.state, browserBinding })).rejects.toMatchObject({
      code: "oauth_state_invalid"
    });
  });

  it("allows only one concurrent consumer", async () => {
    const store = createDurableObjectNamespaceOAuthStateStore(testEnv.OAUTH_STATE_STORE_DO);
    const issued = await store.issue({
      provider: "slack",
      appId: "app_worker",
      tenantId: "tenant_worker",
      actorSubject: "manager_worker",
      browserBinding,
      redirectUri: "https://admin.example.test/oauth/slack/callback"
    });

    const outcomes = await Promise.allSettled([
      store.consume({ state: issued.state, browserBinding }),
      store.consume({ state: issued.state, browserBinding })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    expect(failure?.status).toBe("rejected");
    if (failure?.status !== "rejected") throw new Error("expected one rejected consumer");
    expect(failure.reason).toBeInstanceOf(OAuthStateStoreError);
    expect(failure.reason).toMatchObject({ code: "oauth_state_invalid" });
  });
});

async function shardName(state: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `oauth-state-v1-${hex.slice(0, 2)}`;
}
