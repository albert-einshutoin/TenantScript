import { describe, expect, it, vi } from "vitest";
import { createAuditExportService, verifyAuditExport, type ExecutionRecord } from "../src/index.js";

const signingKey = "audit-export-test-key-that-is-at-least-32-bytes";
const signingKeyId = "audit-export-2026-07";
const request = {
  appId: "app_1",
  tenantId: "tenant_1",
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z")
};

describe("audit compliance export", () => {
  it("exports a period as minimized NDJSON with a signed hash manifest", async () => {
    const search = vi.fn().mockResolvedValue([
      execution("exec_1", "2026-07-10T00:00:00.000Z"),
      {
        ...execution("exec_2", "2026-07-11T00:00:00.000Z"),
        status: "error",
        error: "secret-token-must-not-be-exported"
      }
    ] satisfies ExecutionRecord[]);
    const exporter = createAuditExportService({
      search,
      signingKey,
      signingKeyId,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });

    const result = await exporter.exportPeriod(request);

    expect(search).toHaveBeenCalledWith(request);
    expect(result.ndjson.trim().split("\n")).toHaveLength(2);
    expect(result.ndjson).toContain('"errorPresent":true');
    expect(result.ndjson).not.toContain("secret-token-must-not-be-exported");
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      appId: "app_1",
      tenantId: "tenant_1",
      eventCount: 2,
      signatureAlgorithm: "HMAC-SHA-256",
      signingKeyId
    });
    expect(result.manifest.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.signature).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyAuditExport(result, signingKey)).resolves.toBe(true);
  });

  it("rejects content and manifest tampering", async () => {
    const exporter = createAuditExportService({
      search: () => Promise.resolve([execution("exec_1", "2026-07-10T00:00:00.000Z")]),
      signingKey,
      signingKeyId,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
    const result = await exporter.exportPeriod(request);

    await expect(
      verifyAuditExport({ ...result, ndjson: `${result.ndjson}{}\n` }, signingKey)
    ).resolves.toBe(false);
    await expect(
      verifyAuditExport(
        { ...result, manifest: { ...result.manifest, tenantId: "tenant_forged" } },
        signingKey
      )
    ).resolves.toBe(false);
  });

  it("fails closed when search returns evidence outside the requested tenant or period", async () => {
    const crossTenant = createAuditExportService({
      search: () =>
        Promise.resolve([
          { ...execution("exec_cross", "2026-07-10T00:00:00.000Z"), tenantId: "tenant_other" }
        ]),
      signingKey,
      signingKeyId
    });
    await expect(crossTenant.exportPeriod(request)).rejects.toThrow(
      "audit export search returned out-of-scope evidence"
    );

    const outsidePeriod = createAuditExportService({
      search: () => Promise.resolve([execution("exec_old", "2026-06-30T23:59:59.999Z")]),
      signingKey,
      signingKeyId
    });
    await expect(outsidePeriod.exportPeriod(request)).rejects.toThrow(
      "audit export search returned out-of-scope evidence"
    );
  });

  it("validates signing configuration, export ranges, empty output, and manifest shape", async () => {
    expect(() =>
      createAuditExportService({
        search: () => Promise.resolve([]),
        signingKey: "short",
        signingKeyId
      })
    ).toThrow("audit export signing key must be at least 32 bytes");
    expect(() =>
      createAuditExportService({
        search: () => Promise.resolve([]),
        signingKey,
        signingKeyId: " "
      })
    ).toThrow("audit export signing key id must not be empty");

    const exporter = createAuditExportService({
      search: () => Promise.resolve([]),
      signingKey,
      signingKeyId,
      now: () => new Date("2026-08-01T00:00:00.000Z")
    });
    const empty = await exporter.exportPeriod(request);
    expect(empty.ndjson).toBe("");
    await expect(verifyAuditExport(empty, signingKey)).resolves.toBe(true);
    await expect(
      verifyAuditExport(
        { ...empty, manifest: { ...empty.manifest, signature: "invalid" } },
        signingKey
      )
    ).resolves.toBe(false);
    await expect(exporter.exportPeriod({ ...request, appId: "" })).rejects.toThrow(
      "audit export scope must not be empty"
    );
    await expect(exporter.exportPeriod({ ...request, from: new Date(Number.NaN) })).rejects.toThrow(
      "from must be a valid date"
    );
    await expect(
      exporter.exportPeriod({ ...request, from: request.to, to: request.from })
    ).rejects.toThrow("audit export range is invalid");

    const invalidClock = createAuditExportService({
      search: () => Promise.resolve([]),
      signingKey,
      signingKeyId,
      now: () => new Date(Number.NaN)
    });
    await expect(invalidClock.exportPeriod(request)).rejects.toThrow(
      "generatedAt must be a valid date"
    );
  });
});

function execution(id: string, createdAt: string): ExecutionRecord {
  return {
    id,
    tenantId: "tenant_1",
    pluginId: "plugin_1",
    hookName: "invoice.created",
    version: "1.0.0",
    status: "success",
    durationMs: 12,
    capabilityCalls: [{ name: "invoice.read", status: "success" }],
    createdAt: new Date(createdAt)
  };
}
