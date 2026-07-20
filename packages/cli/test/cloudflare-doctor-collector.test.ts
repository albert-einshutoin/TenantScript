import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_PLANE_MIGRATION_MANIFEST,
  createCloudflareDoctorCollector,
  type DoctorReportV2
} from "../src/index.js";

const databaseId = "023e105f-4ece-48ad-9ca3-1a8372d0c353";
const expectedMigrationNames = CONTROL_PLANE_MIGRATION_MANIFEST.map(({ name }) => name);

describe("Cloudflare doctor collector", () => {
  it("collects a deterministic secret-free V2 snapshot without inventing permissions", async () => {
    const bindingPresence = vi.fn(() => ({ DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true }));
    const secretPresence = vi.fn(() => true);
    const report: DoctorReportV2 = await createCollector({
      bindingPresence,
      secretPresence
    }).collect();

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
      runtime: { configured: "cloudflare-workers", supported: ["cloudflare-workers"] },
      secrets: { ADMIN_CURSOR_SECRET: true }
    });
    expect(bindingPresence).toHaveBeenCalledWith(databaseId);
    expect(secretPresence).toHaveBeenCalledWith("ADMIN_CURSOR_SECRET");
  });

  it("preserves missing bindings, migrations, and secret presence", async () => {
    await expect(
      createCollector({
        bindings: { DB: false, ADMIN_MUTATION_RATE_LIMITER_DO: false },
        applied: expectedMigrationNames.slice(0, 2),
        secretPresent: false
      }).collect()
    ).resolves.toMatchObject({
      bindings: { DB: false, ADMIN_MUTATION_RATE_LIMITER_DO: false },
      migrations: { applied: [1, 2] },
      secrets: { ADMIN_CURSOR_SECRET: false }
    });
  });

  it.each([
    [
      "unknown binding key",
      { DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true, token: "secret-sentinel" }
    ],
    ["missing binding key", { DB: true }],
    ["non-boolean binding", { DB: "secret-sentinel", ADMIN_MUTATION_RATE_LIMITER_DO: true }]
  ])("rejects malformed binding presence without reflection: %s", async (_name, bindings) => {
    const error = await captureError(createCollector({ bindings: bindings as never }).collect());

    expect(error).toMatchObject({ code: "cloudflare_doctor_invalid_response" });
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
    const error = await captureError(
      createCollector({
        bindingPresence: () => Promise.reject(new Error("provider secret-sentinel response"))
      }).collect()
    );

    expect(error).toMatchObject({ code: "cloudflare_doctor_collection_failed" });
    expect(error.message).not.toContain("secret-sentinel");
  });

  it("rejects a non-boolean value from the secret presence reader", async () => {
    await expect(
      createCollector({ secretPresence: () => Promise.resolve(null as never) }).collect()
    ).rejects.toMatchObject({ code: "cloudflare_doctor_invalid_response" });
  });

  it("rejects invalid configuration with a stable public error", () => {
    expect(() =>
      createCloudflareDoctorCollector({
        databaseId: "SECRET invalid database",
        bindingPresence: { read: () => ({ DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true }) },
        migrationReader: { listApplied: () => [] },
        secretPresence: { has: () => true },
        runtime: { configured: "cloudflare-workers", supported: ["cloudflare-workers"] }
      })
    ).toThrow("cloudflare_doctor_invalid_configuration");
  });
});

function createCollector(
  options: {
    bindings?: { DB: boolean; ADMIN_MUTATION_RATE_LIMITER_DO: boolean };
    applied?: readonly string[];
    secretPresent?: boolean;
    bindingPresence?: () => unknown;
    secretPresence?: () => unknown;
  } = {}
) {
  return createCloudflareDoctorCollector({
    databaseId,
    bindingPresence: {
      read: (options.bindingPresence ??
        (() => options.bindings ?? { DB: true, ADMIN_MUTATION_RATE_LIMITER_DO: true })) as never
    },
    migrationReader: { listApplied: vi.fn(() => options.applied ?? expectedMigrationNames) },
    secretPresence: {
      has: (options.secretPresence ?? (() => options.secretPresent ?? true)) as never
    },
    runtime: { configured: "cloudflare-workers", supported: ["cloudflare-workers"] }
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
