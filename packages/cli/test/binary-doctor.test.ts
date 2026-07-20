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
      if (url.pathname.endsWith(`/workers/scripts/${workerName}/settings`)) {
        return Promise.resolve(
          response({
            bindings: [
              { name: "DB", type: "d1", database_id: databaseId },
              {
                name: "ADMIN_MUTATION_RATE_LIMITER_DO",
                type: "durable_object_namespace",
                class_name: "AdminMutationRateLimitDurableObject"
              },
              { name: "ADMIN_CURSOR_SECRET", type: "secret_text", text: "secret-sentinel" }
            ]
          })
        );
      }
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      const requestBody = JSON.parse(init.body) as { sql?: string };
      const rows = requestBody.sql?.includes("sqlite_schema")
        ? [{ name: "d1_migrations" }]
        : CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => ({ name }));
      return Promise.resolve(response([{ success: true, results: rows, meta: {} }]));
    });
    const runtime = createBinaryDoctorRuntime(
      { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken },
      fetchImpl
    );

    const report = await runtime.collectCloudflareDoctor?.({
      workerName,
      databaseId,
      runtime: "cloudflare-workers"
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
});

function response(result: unknown): Response {
  return Response.json({ success: true, result });
}
