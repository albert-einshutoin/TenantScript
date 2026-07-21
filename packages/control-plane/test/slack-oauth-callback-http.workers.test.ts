import { env } from "cloudflare:workers";
import { applyD1Migrations, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createD1ControlPlaneStore,
  createDurableObjectNamespaceSecretStore,
  SLACK_OAUTH_BROWSER_BINDING_COOKIE
} from "../src/index.js";
import worker from "../src/worker-entry.js";

interface TestWorkersEnv {
  ADMIN_MUTATION_RATE_LIMITER_DO: DurableObjectNamespace;
  DB: D1Database;
  OAUTH_STATE_STORE_DO: DurableObjectNamespace;
  PROVIDER_SECRET_STORE_DO: DurableObjectNamespace;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestWorkersEnv;
const controlOrigin = "https://control.example.test";
const callbackPath = "/v1/provider-callbacks/slack";
const callbackUri = `${controlOrigin}${callbackPath}`;
const successRedirectUri = "https://admin.example.test/settings/providers/slack/success";
const failureRedirectUri = "https://admin.example.test/settings/providers/slack/failure";
const rawToken = "xoxb-secret-worker-token";
const rawRefreshToken = "xoxe-secret-worker-refresh-token";
const keyring = JSON.stringify({
  currentKeyId: "test-key-v1",
  keys: [{ id: "test-key-v1", material: "A".repeat(43) }]
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const store = createD1ControlPlaneStore(testEnv.DB);
  await store.createApp({ id: "app_worker", name: "Worker App" });
  await store.createTenant({ id: "tenant_worker", appId: "app_worker", name: "Worker Tenant" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production Slack OAuth callback HTTP Worker composition", () => {
  it("completes install-start once and stores the Slack token only in the encrypted secret DO", async () => {
    const slackFetch = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: rawToken,
        token_type: "bot",
        scope: "chat:write,commands",
        bot_user_id: "B_WORKER",
        app_id: "A_WORKER",
        expires_in: 43_200,
        refresh_token: rawRefreshToken,
        team: { id: "T_WORKER", name: "Worker Workspace" },
        enterprise: null,
        authed_user: { id: "U_WORKER", scope: "" },
        is_enterprise_install: false
      })
    );
    vi.stubGlobal("fetch", slackFetch);
    const runtimeEnv = callbackEnvironment();

    const start = await worker.fetch(
      new Request(`${controlOrigin}/v1/admin/provider-connections/slack/oauth/start`, {
        method: "POST",
        headers: {
          Authorization: "Bearer manager-token",
          Origin: "https://admin.example.test"
        }
      }),
      runtimeEnv
    );
    const startBody: { authorizationUrl: string } = await start.json();
    const state = new URL(startBody.authorizationUrl).searchParams.get("state");
    const setCookie = start.headers.get("Set-Cookie");
    const browserBinding = setCookie?.match(
      new RegExp(`^${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=([A-Za-z0-9_-]{43});`, "u")
    )?.[1];

    expect(start.status).toBe(201);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const callbackRequest = () =>
      new Request(`${callbackUri}?state=${state as string}&code=temporary-worker-code`, {
        headers: callbackNavigationHeaders(browserBinding as string)
      });
    const callback = await worker.fetch(callbackRequest(), runtimeEnv);
    const replay = await worker.fetch(callbackRequest(), runtimeEnv);

    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(successRedirectUri);
    expect(callback.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(JSON.stringify([...callback.headers])).not.toContain(rawToken);
    expect(JSON.stringify([...callback.headers])).not.toContain(rawRefreshToken);
    expect(await callback.clone().text()).not.toContain(rawToken);
    expect(await callback.clone().text()).not.toContain(rawRefreshToken);
    expect(replay.status).toBe(303);
    expect(replay.headers.get("Location")).toBe(failureRedirectUri);
    expect(slackFetch).toHaveBeenCalledTimes(1);

    const connection = await testEnv.DB.prepare(
      "SELECT tenant_id, workspace_id, workspace_name, bot_user_id, secret_ref_json FROM slack_connections"
    ).first<{
      tenant_id: string;
      workspace_id: string;
      workspace_name: string;
      bot_user_id: string;
      secret_ref_json: string;
    }>();
    expect(connection).toMatchObject({
      tenant_id: "tenant_worker",
      workspace_id: "T_WORKER",
      workspace_name: "Worker Workspace",
      bot_user_id: "B_WORKER"
    });
    expect(JSON.stringify(connection)).not.toContain(rawToken);
    expect(JSON.stringify(connection)).not.toContain(rawRefreshToken);
    const secretRef = JSON.parse(connection?.secret_ref_json as string) as {
      provider: "slack";
      appId: string;
      tenantId: string;
      secretId: string;
    };
    expect(secretRef.appId).toBe("app_worker");
    const credential = await createDurableObjectNamespaceSecretStore(
      testEnv.PROVIDER_SECRET_STORE_DO
    ).getSecret(secretRef);
    expect(JSON.parse(credential as string)).toMatchObject({
      version: 1,
      status: "ready",
      generation: 1,
      accessToken: rawToken,
      refreshToken: rawRefreshToken
    });
    const stub = testEnv.PROVIDER_SECRET_STORE_DO.get(
      testEnv.PROVIDER_SECRET_STORE_DO.idFromName(
        await tenantObjectName(secretRef.appId, secretRef.tenantId)
      )
    );
    const persisted = await runInDurableObject(stub, (_instance, state) => state.storage.list());
    expect(JSON.stringify([...persisted.values()])).not.toContain(rawToken);
    expect(JSON.stringify([...persisted.values()])).not.toContain(rawRefreshToken);
  });

  it("fails closed without reflecting partial callback configuration", async () => {
    const secret = "client-secret-sentinel";
    const response = await worker.fetch(
      new Request(`${callbackUri}?state=${"s".repeat(43)}&code=temporary-code`, {
        headers: { Cookie: `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${"b".repeat(43)}` }
      }),
      {
        DB: testEnv.DB,
        OAUTH_STATE_STORE_DO: testEnv.OAUTH_STATE_STORE_DO,
        SLACK_OAUTH_CLIENT_ID: "123.456",
        SLACK_OAUTH_CLIENT_SECRET: secret,
        SLACK_OAUTH_REDIRECT_URI: callbackUri
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(await response.text()).not.toContain(secret);
  });

  it("clears the browser binding when the app database router configuration is invalid", async () => {
    const response = await worker.fetch(
      new Request(`${callbackUri}?state=${"s".repeat(43)}&code=temporary-code`, {
        headers: callbackNavigationHeaders("b".repeat(43))
      }),
      {
        ...callbackEnvironment(),
        APP_DATABASE_ROUTES_JSON: "{"
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("validates the provider keyring before consuming state or exchanging the Slack code", async () => {
    const slackFetch = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: rawToken,
        token_type: "bot",
        scope: "commands",
        app_id: "A_WORKER",
        team: { id: "T_KEYRING" },
        authed_user: { id: "U_WORKER", scope: "" },
        is_enterprise_install: false
      })
    );
    vi.stubGlobal("fetch", slackFetch);
    const validEnvironment = callbackEnvironment();
    const start = await worker.fetch(
      new Request(`${controlOrigin}/v1/admin/provider-connections/slack/oauth/start`, {
        method: "POST",
        headers: {
          Authorization: "Bearer manager-token",
          Origin: "https://admin.example.test"
        }
      }),
      validEnvironment
    );
    const startBody: { authorizationUrl: string } = await start.json();
    const state = new URL(startBody.authorizationUrl).searchParams.get("state");
    const binding = start.headers
      .get("Set-Cookie")
      ?.match(new RegExp(`^${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=([A-Za-z0-9_-]{43});`, "u"))?.[1];
    const callbackRequest = () =>
      new Request(`${callbackUri}?state=${state as string}&code=keyring-code`, {
        headers: callbackNavigationHeaders(binding as string)
      });

    const invalid = await worker.fetch(callbackRequest(), {
      ...validEnvironment,
      PROVIDER_SECRET_KEYRING_JSON: "{"
    });

    expect(invalid.status).toBe(503);
    expect(invalid.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(slackFetch).not.toHaveBeenCalled();

    const retry = await worker.fetch(callbackRequest(), validEnvironment);
    expect(retry.status).toBe(303);
    expect(retry.headers.get("Location")).toBe(successRedirectUri);
    expect(slackFetch).toHaveBeenCalledTimes(1);
  });

  it("selects the sharded D1 database only from the app restored by one-time state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ok: true,
          access_token: rawToken,
          token_type: "bot",
          scope: "commands",
          app_id: "A_WORKER",
          team: { id: "T_SHARDED" },
          authed_user: { id: "U_WORKER", scope: "" },
          is_enterprise_install: false
        })
      )
    );
    const base = callbackEnvironment();
    const { DB: appDatabase, ...withoutFallback } = base;
    const runtimeEnv = {
      ...withoutFallback,
      APP_DATABASE_ROUTES_JSON: JSON.stringify({ app_worker: "APP_DB" }),
      APP_DB: appDatabase
    };
    const start = await worker.fetch(
      new Request(`${controlOrigin}/v1/admin/provider-connections/slack/oauth/start`, {
        method: "POST",
        headers: {
          Authorization: "Bearer manager-token",
          Origin: "https://admin.example.test"
        }
      }),
      runtimeEnv
    );
    const startBody: { authorizationUrl: string } = await start.json();
    const state = new URL(startBody.authorizationUrl).searchParams.get("state");
    const binding = start.headers
      .get("Set-Cookie")
      ?.match(new RegExp(`^${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=([A-Za-z0-9_-]{43});`, "u"))?.[1];

    const callback = await worker.fetch(
      new Request(`${callbackUri}?state=${state as string}&code=sharded-code`, {
        headers: callbackNavigationHeaders(binding as string)
      }),
      runtimeEnv
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe(successRedirectUri);
    await expect(
      appDatabase
        .prepare("SELECT workspace_id FROM slack_connections WHERE tenant_id = ?")
        .bind("tenant_worker")
        .first()
    ).resolves.toEqual({ workspace_id: "T_SHARDED" });
  });
});

async function tenantObjectName(appId: string, tenantId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([appId, tenantId]))
  );
  return `provider-secrets-v1-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function callbackEnvironment() {
  return {
    ADMIN_ALLOWED_ORIGINS: JSON.stringify(["https://admin.example.test"]),
    ADMIN_IDENTITIES_JSON: JSON.stringify({
      "manager-token": {
        subject: "auth0|manager@example.test",
        role: "manager",
        appId: "app_worker",
        tenantId: "tenant_worker"
      }
    }),
    ADMIN_MUTATION_RATE_LIMITER_DO: testEnv.ADMIN_MUTATION_RATE_LIMITER_DO,
    DB: testEnv.DB,
    OAUTH_STATE_STORE_DO: testEnv.OAUTH_STATE_STORE_DO,
    PROVIDER_SECRET_KEYRING_JSON: keyring,
    PROVIDER_SECRET_STORE_DO: testEnv.PROVIDER_SECRET_STORE_DO,
    SLACK_OAUTH_CLIENT_ID: "123456789.987654321",
    SLACK_OAUTH_CLIENT_SECRET: "synthetic-client-secret",
    SLACK_OAUTH_FAILURE_REDIRECT_URI: failureRedirectUri,
    SLACK_OAUTH_REDIRECT_URI: callbackUri,
    SLACK_OAUTH_SCOPES: "chat:write,commands",
    SLACK_OAUTH_SUCCESS_REDIRECT_URI: successRedirectUri
  };
}

function callbackNavigationHeaders(binding: string): HeadersInit {
  return {
    Cookie: `${SLACK_OAUTH_BROWSER_BINDING_COOKIE}=${binding}`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate"
  };
}
