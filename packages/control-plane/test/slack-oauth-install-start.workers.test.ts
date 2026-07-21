import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createDurableObjectNamespaceOAuthStateStore } from "../src/index.js";
import worker from "../src/worker-entry.js";

interface TestWorkersEnv {
  ADMIN_MUTATION_RATE_LIMITER_DO: DurableObjectNamespace;
  OAUTH_STATE_STORE_DO: DurableObjectNamespace;
}

const testEnv = env as unknown as TestWorkersEnv;
const endpoint = "https://control.example.test/v1/admin/provider-connections/slack/oauth/start";

beforeEach(async () => {
  await reset();
});

describe("production Slack OAuth install-start Worker composition", () => {
  it("binds the authenticated browser to a real one-time Durable Object state", async () => {
    const response = await worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer manager-token",
          Origin: "https://admin.example.test"
        }
      }),
      {
        ADMIN_ALLOWED_ORIGINS: JSON.stringify(["https://admin.example.test"]),
        ADMIN_MUTATION_RATE_LIMITER_DO: testEnv.ADMIN_MUTATION_RATE_LIMITER_DO,
        ADMIN_IDENTITIES_JSON: JSON.stringify({
          "manager-token": {
            subject: "auth0|abc+manager@example.com",
            role: "manager",
            appId: "app_worker",
            tenantId: "tenant_worker"
          }
        }),
        OAUTH_STATE_STORE_DO: testEnv.OAUTH_STATE_STORE_DO,
        SLACK_OAUTH_CLIENT_ID: "123456789.987654321",
        SLACK_OAUTH_SCOPES: "chat:write,commands",
        SLACK_OAUTH_REDIRECT_URI: "https://control.example.test/v1/provider-callbacks/slack"
      }
    );

    expect(response.status).toBe(201);
    const body: { authorizationUrl: string; expiresAt: string } = await response.json();
    const authorizationUrl = new URL(body.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    const cookie = response.headers.get("Set-Cookie");
    const browserBinding = cookie?.match(
      /^__Host-tenantscript-slack-oauth-binding=([A-Za-z0-9_-]{43});/u
    )?.[1];

    expect(authorizationUrl.origin).toBe("https://slack.com");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("123456789.987654321");
    expect(authorizationUrl.searchParams.get("scope")).toBe("chat:write,commands");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "https://control.example.test/v1/provider-callbacks/slack"
    );
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(cookie).toContain("; Secure; HttpOnly; SameSite=None");
    expect(JSON.stringify(body)).not.toContain(browserBinding);

    const store = createDurableObjectNamespaceOAuthStateStore(testEnv.OAUTH_STATE_STORE_DO);
    await expect(
      store.consume({ state: state as string, browserBinding: browserBinding as string })
    ).resolves.toMatchObject({
      provider: "slack",
      appId: "app_worker",
      tenantId: "tenant_worker",
      actorSubject: "auth0|abc+manager@example.com",
      redirectUri: "https://control.example.test/v1/provider-callbacks/slack"
    });
    await expect(
      store.consume({ state: state as string, browserBinding: browserBinding as string })
    ).rejects.toMatchObject({ code: "oauth_state_invalid" });
  });

  it("redacts invalid Slack configuration before issuing state or a cookie", async () => {
    const secret = "https://user:secret@control.example.test/callback";
    const response = await worker.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: { Authorization: "Bearer manager-token" }
      }),
      {
        ADMIN_IDENTITIES_JSON: JSON.stringify({
          "manager-token": {
            subject: "manager_worker",
            role: "manager",
            appId: "app_worker",
            tenantId: "tenant_worker"
          }
        }),
        OAUTH_STATE_STORE_DO: testEnv.OAUTH_STATE_STORE_DO,
        SLACK_OAUTH_CLIENT_ID: "123.456",
        SLACK_OAUTH_SCOPES: "commands",
        SLACK_OAUTH_REDIRECT_URI: secret
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).not.toContain(secret);
  });
});
