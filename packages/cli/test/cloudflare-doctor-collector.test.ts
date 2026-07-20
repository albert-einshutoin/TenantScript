import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  createCloudflareDoctorCollector,
  type CloudflareApiTransport,
  type DoctorReportV2
} from "../src/index.js";

const workerName = "tenantscript-control-plane";
const databaseId = "023e105f-4ece-48ad-9ca3-1a8372d0c353";
const expectedMigrationNames = CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => name);

describe("Cloudflare doctor collector", () => {
  it("collects a deterministic secret-free V2 snapshot without inventing permissions", async () => {
    const requests: RecordedRequest[] = [];
    const collector = createCollector({
      requests,
      settings: {
        bindings: [
          { name: "DB", type: "d1", database_id: databaseId },
          {
            name: "ADMIN_MUTATION_RATE_LIMITER_DO",
            type: "durable_object_namespace",
            class_name: "AdminMutationRateLimitDurableObject"
          }
        ]
      }
    });

    const report: DoctorReportV2 = await collector.collect();

    expect(report).toEqual({
      version: 2,
      profile: "production",
      bindings: { DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true },
      migrations: {
        expected: expectedMigrationNames.map((_, index) => index + 1),
        applied: expectedMigrationNames.map((_, index) => index + 1)
      },
      permissions: {
        D1_READ: "unverified",
        D1_WRITE: "unverified",
        WORKERS_SCRIPTS_WRITE: "unverified"
      },
      runtime: {
        configured: "cloudflare-workers",
        supported: ["cloudflare-workers"]
      },
      secrets: { ADMIN_CURSOR_SECRET: true }
    });
    expect(requests).toEqual([
      { method: "GET", pathSegments: ["workers", "scripts", workerName, "settings"] }
    ]);
    expect(JSON.stringify(report)).not.toMatch(/database_id|023e105f|class_name/iu);
  });

  it("preserves missing bindings, migrations, and secret presence without provider identifiers", async () => {
    const collector = createCollector({
      settings: { bindings: [] },
      applied: expectedMigrationNames.slice(0, 2),
      secretPresent: false
    });

    await expect(collector.collect()).resolves.toMatchObject({
      bindings: { DB: false, ADMIN_MUTATION_RATE_LIMITER_DO: false },
      migrations: { applied: [1, 2] },
      secrets: { ADMIN_CURSOR_SECRET: false }
    });
  });

  it("treats an omitted optional bindings field as no configured bindings", async () => {
    const collector = createCollector({
      settings: { compatibility_date: "2026-07-21" }
    });

    await expect(collector.collect()).resolves.toMatchObject({
      bindings: { DB: false, ADMIN_MUTATION_RATE_LIMITER_DO: false }
    });
  });

  it.each([
    ["unknown settings field", { bindings: [], token: "secret-sentinel" }],
    [
      "duplicate target binding",
      {
        bindings: [
          { name: "DB", type: "d1", database_id: databaseId },
          { name: "DB", type: "d1", database_id: databaseId }
        ]
      }
    ],
    ["malformed bindings", { bindings: "secret-sentinel" }]
  ])("fails closed without reflecting provider data: %s", async (_name, settings) => {
    const collector = createCollector({ settings });

    const error = await captureError(collector.collect());

    expect(error).toMatchObject({ code: "cloudflare_doctor_invalid_response" });
    expect(error.message).toBe("cloudflare_doctor_invalid_response");
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it.each([
    ["unknown migration", [...expectedMigrationNames.slice(0, 2), "9999_secret-sentinel.sql"]],
    [
      "duplicate migration",
      [...expectedMigrationNames.slice(0, 1), ...expectedMigrationNames.slice(0, 1)]
    ],
    ["non-prefix migration", expectedMigrationNames.slice(1, 2)],
    ["oversized history", [...expectedMigrationNames, ...expectedMigrationNames.slice(0, 1)]]
  ])("rejects malformed migration history without reflection: %s", async (_name, applied) => {
    const error = await captureError(createCollector({ applied }).collect());

    expect(error).toMatchObject({ code: "cloudflare_doctor_invalid_response" });
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });

  it("normalizes trusted-source failures without reflecting their messages", async () => {
    const transport: CloudflareApiTransport = {
      request: vi.fn(() => Promise.reject(new Error("provider secret-sentinel response")))
    };
    const collector = createCloudflareDoctorCollector({
      transport,
      workerName,
      databaseId,
      migrationReader: { listApplied: () => expectedMigrationNames },
      secretPresence: { has: () => true },
      runtime: { configured: "cloudflare-workers", supported: ["cloudflare-workers"] }
    });

    const error = await captureError(collector.collect());

    expect(error).toMatchObject({ code: "cloudflare_doctor_collection_failed" });
    expect(error.message).not.toContain("secret-sentinel");
  });

  it("rejects invalid configuration with a stable public error", () => {
    expect(() =>
      createCloudflareDoctorCollector({
        transport: { request: vi.fn() },
        workerName: "SECRET invalid worker",
        databaseId,
        migrationReader: { listApplied: () => [] },
        secretPresence: { has: () => true },
        runtime: { configured: "cloudflare-workers", supported: ["cloudflare-workers"] }
      })
    ).toThrow("cloudflare_doctor_invalid_configuration");
  });
});

interface RecordedRequest {
  method: string;
  pathSegments: readonly string[];
}

function createCollector(
  options: {
    requests?: RecordedRequest[];
    settings?: unknown;
    applied?: readonly string[];
    secretPresent?: boolean;
  } = {}
) {
  const transport: CloudflareApiTransport = {
    request: vi.fn((request: Parameters<CloudflareApiTransport["request"]>[0]) => {
      options.requests?.push({ method: request.method, pathSegments: request.pathSegments });
      return Promise.resolve(options.settings ?? { bindings: [] });
    })
  };
  return createCloudflareDoctorCollector({
    transport,
    workerName,
    databaseId,
    migrationReader: {
      listApplied: vi.fn(() => options.applied ?? expectedMigrationNames)
    },
    secretPresence: {
      has: vi.fn(() => options.secretPresent ?? true)
    },
    runtime: {
      configured: "cloudflare-workers",
      supported: ["cloudflare-workers"]
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
