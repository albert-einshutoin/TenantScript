import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateDoctorReport,
  evaluateDoctorReportV2,
  parseDoctorReport,
  parseDoctorReportV2,
  runExtCli,
  type CliIo,
  type DoctorReportV1,
  type DoctorReportV2,
  type RollbackClient
} from "../src/index.js";

const healthyReport: DoctorReportV1 = {
  version: 1,
  profile: "production",
  bindings: {
    DB: true,
    ADMIN_MUTATION_RATE_LIMITER_DO: true
  },
  migrations: {
    expected: [1, 2, 3],
    applied: [1, 2, 3]
  },
  permissions: {
    D1_READ: true,
    D1_WRITE: true,
    WORKERS_SCRIPTS_WRITE: true
  },
  runtime: {
    configured: "cloudflare-workers",
    supported: ["cloudflare-workers"]
  },
  secrets: {
    ADMIN_CURSOR_SECRET: true
  }
};

const healthyReportV2: DoctorReportV2 = {
  ...healthyReport,
  version: 2,
  permissions: {
    D1_READ: "granted",
    D1_WRITE: "granted",
    WORKERS_SCRIPTS_WRITE: "granted"
  }
};

describe("ext doctor", () => {
  it("returns a healthy deterministic report", () => {
    const parsed: DoctorReportV1 = parseDoctorReport(healthyReport);
    expect(parsed).toEqual(healthyReport);
    expect(evaluateDoctorReport(healthyReport)).toEqual({
      version: 1,
      healthy: true,
      findings: []
    });
  });

  it("accepts a version 2 report only when every permission is verified as granted", () => {
    expect(() => parseDoctorReport(healthyReportV2)).toThrow("doctor report is invalid");
    expect(parseDoctorReportV2(healthyReportV2)).toEqual(healthyReportV2);
    expect(evaluateDoctorReportV2(healthyReportV2)).toEqual({
      version: 1,
      healthy: true,
      findings: []
    });
  });

  it("keeps denied and unverified permission evidence distinct in stable order", () => {
    const result = evaluateDoctorReportV2({
      ...healthyReportV2,
      permissions: {
        D1_READ: "denied",
        D1_WRITE: "unverified",
        WORKERS_SCRIPTS_WRITE: "unverified"
      }
    });

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "doctor_permission_d1_read_missing",
      "doctor_permission_d1_write_unverified",
      "doctor_permission_workers_scripts_write_unverified"
    ]);
    expect(result.healthy).toBe(false);
  });

  it.each([
    ["version 2 boolean", { ...healthyReportV2, permissions: healthyReport.permissions }],
    [
      "version 2 unknown evidence",
      {
        ...healthyReportV2,
        permissions: { ...healthyReportV2.permissions, D1_WRITE: "assumed" }
      }
    ],
    [
      "version 2 extra permission field",
      {
        ...healthyReportV2,
        permissions: { ...healthyReportV2.permissions, token: "secret-sentinel" }
      }
    ]
  ])("rejects malformed permission evidence without reflection: %s", async (_name, report) => {
    const reportPath = await writeReport(report);
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);
    expect(stderr).toEqual(["doctor report is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it("reports every supported failure in a stable order without secret values", () => {
    const result = evaluateDoctorReport({
      ...healthyReport,
      bindings: { DB: false, ADMIN_MUTATION_RATE_LIMITER_DO: false },
      migrations: { expected: [1, 2, 3], applied: [1] },
      permissions: { D1_READ: false, D1_WRITE: false, WORKERS_SCRIPTS_WRITE: false },
      runtime: {
        configured: "workers-for-platforms",
        supported: ["cloudflare-workers"]
      },
      secrets: { ADMIN_CURSOR_SECRET: false }
    });

    expect(result.healthy).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "doctor_binding_db_missing",
      "doctor_binding_rate_limiter_missing",
      "doctor_migrations_pending",
      "doctor_permission_d1_read_missing",
      "doctor_permission_d1_write_missing",
      "doctor_permission_workers_scripts_write_missing",
      "doctor_runtime_primitive_unsupported",
      "doctor_secret_admin_cursor_missing"
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-sentinel");
    for (const finding of result.findings) {
      expect(finding.summary.length).toBeGreaterThan(0);
      expect(finding.repair).toMatch(/^docs\//u);
    }
  });

  it("prints JSON and returns exit 1 for a valid report that needs repair", async () => {
    const report = { ...healthyReport, bindings: { ...healthyReport.bindings, DB: false } };
    const reportPath = await writeReport(report);
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo(stdout, stderr))
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      version: 1,
      healthy: false,
      findings: [{ code: "doctor_binding_db_missing" }]
    });
  });

  it("returns exit 1 when version 2 permission evidence is unverified", async () => {
    const reportPath = await writeReport({
      ...healthyReportV2,
      permissions: { ...healthyReportV2.permissions, D1_WRITE: "unverified" }
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo(stdout, stderr))
    ).resolves.toBe(1);

    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      healthy: false,
      findings: [{ code: "doctor_permission_d1_write_unverified" }]
    });
  });

  it("collects and evaluates a read-only Cloudflare snapshot from exact live options", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const collectCloudflareDoctor = vi.fn(() =>
      Promise.resolve({
        ...healthyReportV2,
        permissions: {
          D1_READ: "unverified" as const,
          D1_WRITE: "unverified" as const,
          WORKERS_SCRIPTS_WRITE: "unverified" as const
        }
      })
    );

    await expect(
      runExtCli(
        [
          "doctor",
          "--cloudflare",
          "--admin-cursor-secret-present",
          "true",
          "--database-id",
          "123e4567-e89b-12d3-a456-426614174000",
          "--config",
          "wrangler.jsonc",
          "--runtime",
          "cloudflare-workers"
        ],
        rollbackOnlyClient,
        captureIo(stdout, stderr),
        { collectCloudflareDoctor }
      )
    ).resolves.toBe(1);

    expect(collectCloudflareDoctor).toHaveBeenCalledOnce();
    expect(collectCloudflareDoctor).toHaveBeenCalledWith({
      adminCursorSecretPresent: true,
      databaseId: "123e4567-e89b-12d3-a456-426614174000",
      configPath: "wrangler.jsonc",
      runtime: "cloudflare-workers"
    });
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      healthy: false,
      findings: [
        { code: "doctor_permission_d1_read_unverified" },
        { code: "doctor_permission_d1_write_unverified" },
        { code: "doctor_permission_workers_scripts_write_unverified" }
      ]
    });
  });

  it("rejects malformed live options before collector access", async () => {
    const stderr: string[] = [];
    const collectCloudflareDoctor = vi.fn();

    await expect(
      runExtCli(
        ["doctor", "--cloudflare", "--admin-cursor-secret-present", "secret-sentinel"],
        rollbackOnlyClient,
        captureIo([], stderr),
        { collectCloudflareDoctor }
      )
    ).resolves.toBe(2);

    expect(collectCloudflareDoctor).not.toHaveBeenCalled();
    expect(stderr).toEqual(["invalid doctor options"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it("rejects a V1 snapshot from an untyped live runtime", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "doctor",
          "--cloudflare",
          "--admin-cursor-secret-present",
          "true",
          "--database-id",
          "123e4567-e89b-12d3-a456-426614174000",
          "--config",
          "wrangler.jsonc",
          "--runtime",
          "cloudflare-workers"
        ],
        rollbackOnlyClient,
        captureIo([], stderr),
        { collectCloudflareDoctor: () => Promise.resolve(healthyReport as never) }
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["cloudflare doctor collection failed"]);
  });

  it.each([
    ["unconfigured", {}, "cloudflare doctor is not configured"],
    [
      "provider failure",
      {
        collectCloudflareDoctor: () =>
          Promise.reject(new Error("token-account-worker-database-secret-sentinel"))
      },
      "cloudflare doctor collection failed"
    ]
  ])(
    "returns a stable non-reflecting diagnostic when live collection is %s",
    async (_scenario, runtime, diagnostic) => {
      const stderr: string[] = [];

      await expect(
        runExtCli(
          [
            "doctor",
            "--cloudflare",
            "--admin-cursor-secret-present",
            "true",
            "--database-id",
            "123e4567-e89b-12d3-a456-426614174000",
            "--config",
            "wrangler.jsonc",
            "--runtime",
            "cloudflare-workers"
          ],
          rollbackOnlyClient,
          captureIo([], stderr),
          runtime
        )
      ).resolves.toBe(2);

      expect(stderr).toEqual([diagnostic]);
      expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
    }
  );

  it("returns exit 2 with a stable diagnostic for unknown fields and does not reflect input", async () => {
    const reportPath = await writeReport({ ...healthyReport, token: "secret-sentinel" });
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo(stdout, stderr))
    ).resolves.toBe(2);

    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["doctor report is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it.each([
    ["unknown version", { ...healthyReport, version: 3 }],
    ["unknown profile", { ...healthyReport, profile: "development" }],
    [
      "duplicate migration",
      { ...healthyReport, migrations: { expected: [1, 2, 2], applied: [1, 2] } }
    ],
    ["reverse migration", { ...healthyReport, migrations: { expected: [1, 3, 2], applied: [1] } }],
    [
      "non-prefix migration",
      { ...healthyReport, migrations: { expected: [1, 2, 3], applied: [1, 3] } }
    ],
    [
      "unknown runtime",
      { ...healthyReport, runtime: { configured: "unknown", supported: ["cloudflare-workers"] } }
    ],
    [
      "duplicate supported runtime",
      {
        ...healthyReport,
        runtime: {
          configured: "cloudflare-workers",
          supported: ["cloudflare-workers", "cloudflare-workers"]
        }
      }
    ]
  ])("rejects malformed reports: %s", async (_name, report) => {
    const reportPath = await writeReport(report);
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);
    expect(stderr).toEqual(["doctor report is invalid"]);
  });

  it("rejects a missing --report option as usage error", async () => {
    const stderr: string[] = [];
    await expect(runExtCli(["doctor"], rollbackOnlyClient, captureIo([], stderr))).resolves.toBe(2);
    expect(stderr).toEqual(["missing required doctor option: --report"]);
  });

  it("does not reflect an unreadable report path", async () => {
    const stderr: string[] = [];
    await expect(
      runExtCli(
        ["doctor", "--report", "/missing/secret-sentinel.json"],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["doctor report could not be read"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it("does not reflect malformed JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenantscript-doctor-invalid-"));
    const reportPath = join(root, "doctor-report.json");
    await writeFile(reportPath, '{"token":"secret-sentinel"');
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);
    expect(stderr).toEqual(["doctor report is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });

  it("rejects an oversized report without reflecting its content", async () => {
    const reportPath = await writeReport("secret-sentinel".repeat(6_000));
    const stderr: string[] = [];

    await expect(
      runExtCli(["doctor", "--report", reportPath], rollbackOnlyClient, captureIo([], stderr))
    ).resolves.toBe(2);
    expect(stderr).toEqual(["doctor report is invalid"]);
    expect(JSON.stringify(stderr)).not.toContain("secret-sentinel");
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback client must not be called");
  }
};

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}

async function writeReport(report: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tenantscript-doctor-"));
  const reportPath = join(root, "doctor-report.json");
  await writeFile(reportPath, JSON.stringify(report));
  return reportPath;
}
