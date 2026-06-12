import { describe, expect, it } from "vitest";
import { measureRollbackDrill, runExtCli, type CliIo, type RollbackClient } from "../src/index.js";

describe("rollback drill measurement", () => {
  it("measures MTTR from broken deploy to rollback completion", () => {
    expect(
      measureRollbackDrill({
        deployedAt: new Date("2026-06-13T00:00:00.000Z"),
        detectedAt: new Date("2026-06-13T00:01:15.000Z"),
        rollbackStartedAt: new Date("2026-06-13T00:02:00.000Z"),
        completedAt: new Date("2026-06-13T00:03:20.000Z")
      })
    ).toEqual({
      deployedAt: "2026-06-13T00:00:00.000Z",
      detectedAt: "2026-06-13T00:01:15.000Z",
      rollbackStartedAt: "2026-06-13T00:02:00.000Z",
      completedAt: "2026-06-13T00:03:20.000Z",
      detectionMs: 75_000,
      rollbackMs: 80_000,
      mttrMs: 200_000,
      thresholdMs: 300_000,
      passed: true
    });
  });

  it("fails measurements at or above the threshold", () => {
    expect(
      measureRollbackDrill({
        deployedAt: new Date("2026-06-13T00:00:00.000Z"),
        detectedAt: new Date("2026-06-13T00:02:00.000Z"),
        rollbackStartedAt: new Date("2026-06-13T00:03:00.000Z"),
        completedAt: new Date("2026-06-13T00:05:00.000Z")
      })
    ).toMatchObject({
      mttrMs: 300_000,
      thresholdMs: 300_000,
      passed: false
    });
  });

  it("rejects timestamps that move backwards", () => {
    expect(() =>
      measureRollbackDrill({
        deployedAt: new Date("2026-06-13T00:00:00.000Z"),
        detectedAt: new Date("2026-06-13T00:02:00.000Z"),
        rollbackStartedAt: new Date("2026-06-13T00:01:59.999Z"),
        completedAt: new Date("2026-06-13T00:03:00.000Z")
      })
    ).toThrow("rollbackStartedAt must be at or after detectedAt");
  });

  it("prints a rollback-drill JSON report", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "rollback-drill",
          "--deployed-at",
          "2026-06-13T00:00:00.000Z",
          "--detected-at",
          "2026-06-13T00:01:15.000Z",
          "--rollback-started-at",
          "2026-06-13T00:02:00.000Z",
          "--completed-at",
          "2026-06-13T00:03:20.000Z",
          "--threshold-ms",
          "240000"
        ],
        unusedRollbackClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);

    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      mttrMs: 200_000,
      thresholdMs: 240_000,
      passed: true
    });
    expect(stderr).toEqual([]);
  });

  it("returns a usage error for invalid rollback-drill timestamps", async () => {
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "rollback-drill",
          "--deployed-at",
          "not-a-date",
          "--detected-at",
          "2026-06-13T00:01:15.000Z",
          "--rollback-started-at",
          "2026-06-13T00:02:00.000Z",
          "--completed-at",
          "2026-06-13T00:03:20.000Z"
        ],
        unusedRollbackClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual(["invalid rollback-drill timestamp: --deployed-at"]);
  });
});

const unusedRollbackClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback client should not be called");
  }
};

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
