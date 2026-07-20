import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  createBinaryDoctorRuntime,
  type CloudflareFetch
} from "../src/index.js";

const accountId = "0123456789abcdef0123456789abcdef";
const apiToken = "fixture-cloudflare-token";
const databaseId = "123e4567-e89b-12d3-a456-426614174000";

describe("binary Cloudflare doctor composition", () => {
  it("collects one secret-free snapshot through the read-only Cloudflare APIs", async () => {
    const fetchImpl = vi.fn<CloudflareFetch>((input, init) => {
      expect(new URL(input).pathname).not.toContain("/workers/");
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      const requestBody = JSON.parse(init.body) as { sql?: string };
      const rows = requestBody.sql?.includes("sqlite_schema")
        ? [{ name: "d1_migrations" }]
        : CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => ({ name }));
      return Promise.resolve(response([{ success: true, results: rows, meta: {} }]));
    });
    const readFile = vi.fn(() => Promise.resolve(validWranglerConfig()));
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl,
      readFile
    );

    const report = await runtime.collectCloudflareDoctor?.({
      databaseId,
      runtime: "cloudflare-workers",
      configPath: "wrangler.jsonc",
      adminCursorSecretPresent: true
    });

    expect(report).toMatchObject({
      version: 2,
      bindings: { DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true },
      secrets: { ADMIN_CURSOR_SECRET: true },
      permissions: {
        D1_READ: "unverified",
        D1_WRITE: "unverified",
        WORKERS_SCRIPTS_WRITE: "unverified"
      }
    });
    expect(JSON.stringify(report)).not.toContain("secret-sentinel");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledWith("wrangler.jsonc", "utf8");
    expect(fetchImpl.mock.calls.map(([input]) => input)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/settings")])
    );
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${apiToken}` });
    }
  });

  it("leaves live collection unconfigured when credentials are absent or invalid", () => {
    const fetchImpl: CloudflareFetch = vi.fn();

    expect(createBinaryDoctorRuntime({}, fetchImpl)).toEqual({});
    expect(
      createBinaryDoctorRuntime(
        {
          CLOUDFLARE_ACCOUNT_ID: "secret-sentinel",
          CLOUDFLARE_API_TOKEN: "secret-sentinel"
        },
        fetchImpl
      )
    ).toEqual({});
  });

  it("reports a missing secret from an explicit value-free operator attestation", async () => {
    const fetchImpl = vi.fn<CloudflareFetch>((_input, init) => Promise.resolve(d1Response(init)));
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl,
      () => Promise.resolve(validWranglerConfig())
    );

    await expect(
      runtime.collectCloudflareDoctor?.({
        databaseId,
        configPath: "wrangler.jsonc",
        runtime: "cloudflare-workers",
        adminCursorSecretPresent: false
      })
    ).resolves.toMatchObject({ secrets: { ADMIN_CURSOR_SECRET: false } });
    expect(fetchImpl.mock.calls.map(([input]) => input)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/workers/")])
    );
  });
});

function response(result: unknown): Response {
  return Response.json({ success: true, result });
}

function d1Response(init: RequestInit): Response {
  if (typeof init.body !== "string") throw new Error("expected JSON request body");
  const requestBody = JSON.parse(init.body) as { sql?: string };
  const rows = requestBody.sql?.includes("sqlite_schema")
    ? [{ name: "d1_migrations" }]
    : CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => ({ name }));
  return response([{ success: true, results: rows, meta: {} }]);
}

function validWranglerConfig(): string {
  return `{
    // The setup renderer emits JSON, but operators may maintain standard JSONC.
    "d1_databases": [{
      "binding": "DB",
      "database_id": "${databaseId.replaceAll("-", "")}",
    }],
    "durable_objects": {
      "bindings": [{
        "name": "ADMIN_MUTATION_RATE_LIMITER_DO",
        "class_name": "AdminMutationRateLimitDurableObject",
      }],
    },
  }`;
}
