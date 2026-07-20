import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  createBinaryDoctorRuntime,
  type CloudflareFetch
} from "../src/index.js";

const accountId = "0123456789abcdef0123456789abcdef";
const apiToken = "fixture-cloudflare-token";
const workerName = "tenantscript-control-plane";
const databaseId = "123e4567-e89b-12d3-a456-426614174000";

describe("binary Cloudflare doctor composition", () => {
  it("collects one secret-free snapshot through the read-only Cloudflare APIs", async () => {
    const fetchImpl = vi.fn<CloudflareFetch>((input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith(`/workers/scripts/${workerName}/secrets/ADMIN_CURSOR_SECRET`)) {
        return Promise.resolve(response({ name: "ADMIN_CURSOR_SECRET", type: "secret_text" }));
      }
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      const requestBody = JSON.parse(init.body) as { sql?: string };
      const rows = requestBody.sql?.includes("sqlite_schema")
        ? [{ name: "d1_migrations" }]
        : CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => ({ name }));
      return Promise.resolve(response([{ success: true, results: rows, meta: {} }]));
    });
    const readFile = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          d1_databases: [{ binding: "DB", database_id: databaseId }],
          durable_objects: {
            bindings: [
              {
                name: "ADMIN_MUTATION_RATE_LIMITER_DO",
                class_name: "AdminMutationRateLimitDurableObject"
              }
            ]
          }
        })
      )
    );
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl,
      readFile
    );

    const report = await runtime.collectCloudflareDoctor?.({
      workerName,
      databaseId,
      runtime: "cloudflare-workers",
      configPath: "wrangler.jsonc"
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
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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

  it("reports a missing secret from the value-omitting metadata endpoint", async () => {
    const fetchImpl = vi.fn<CloudflareFetch>((input, init) => {
      if (new URL(input).pathname.includes("/secrets/ADMIN_CURSOR_SECRET")) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(d1Response(init));
    });
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl,
      () => Promise.resolve(validWranglerConfig())
    );

    await expect(
      runtime.collectCloudflareDoctor?.({
        workerName,
        databaseId,
        configPath: "wrangler.jsonc",
        runtime: "cloudflare-workers"
      })
    ).resolves.toMatchObject({ secrets: { ADMIN_CURSOR_SECRET: false } });
  });

  it("fails closed if secret metadata contains an undocumented value field", async () => {
    const fetchImpl = vi.fn<CloudflareFetch>((input, init) => {
      if (new URL(input).pathname.includes("/secrets/ADMIN_CURSOR_SECRET")) {
        return Promise.resolve(
          response({ name: "ADMIN_CURSOR_SECRET", type: "secret_text", text: "secret-sentinel" })
        );
      }
      return Promise.resolve(d1Response(init));
    });
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl,
      () => Promise.resolve(validWranglerConfig())
    );

    const error = await captureError(
      runtime.collectCloudflareDoctor?.({
        workerName,
        databaseId,
        configPath: "wrangler.jsonc",
        runtime: "cloudflare-workers"
      }) ?? Promise.resolve()
    );

    expect(error).toMatchObject({ code: "cloudflare_doctor_collection_failed" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
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
  return JSON.stringify({
    d1_databases: [{ binding: "DB", database_id: databaseId }],
    durable_objects: {
      bindings: [
        {
          name: "ADMIN_MUTATION_RATE_LIMITER_DO",
          class_name: "AdminMutationRateLimitDurableObject"
        }
      ]
    }
  });
}

async function captureError(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected collector failure");
}
