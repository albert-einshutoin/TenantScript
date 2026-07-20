import type { TenantScriptManifest } from "@tenantscript/manifest";
import { describe, expect, it } from "vitest";
import {
  SchemaMigrationBlockedError,
  createD1SchemaMigrationTracker,
  parsePublishedHookSchemaCatalog,
  type D1DatabaseLike
} from "../src/index.js";

describe("schema migration catalog", () => {
  it("parses a valid catalog and reports malformed entries with stable errors", () => {
    expect(
      parsePublishedHookSchemaCatalog({
        "invoice.created": ["1.0.0", "2.0.0"]
      })
    ).toEqual({ "invoice.created": ["1.0.0", "2.0.0"] });

    expect(() => parsePublishedHookSchemaCatalog(null)).toThrow(
      "hook schema catalog must be an object"
    );
    expect(() => parsePublishedHookSchemaCatalog({ hook: [1] })).toThrow(
      "hook schema catalog entry hook must contain versions"
    );
    expect(() => parsePublishedHookSchemaCatalog({ " hook": ["1.0.0"] })).toThrow(
      "hook schema catalog entries must not be empty"
    );
    expect(() => parsePublishedHookSchemaCatalog({ hook: [] })).toThrow(
      "hook schema catalog entries must not be empty"
    );
    expect(() => parsePublishedHookSchemaCatalog({ hook: ["latest"] })).toThrow(
      "hook schema catalog entry hook contains an invalid version"
    );
    expect(() => parsePublishedHookSchemaCatalog({ hook: ["1.0.0-beta.1"] })).toThrow(
      "hook schema catalog entry hook contains a prerelease version"
    );
    expect(() => parsePublishedHookSchemaCatalog({ hook: ["1.0.0", "1.0.0"] })).toThrow(
      "hook schema catalog entry hook contains duplicate versions"
    );
  });
});

describe("schema migration tracker", () => {
  it("sorts hooks and versions and ignores manifests without the tracked hook", async () => {
    const tracker = createD1SchemaMigrationTracker(
      databaseWithRows([installationRow("installation_other", manifest("other.event", "^1.0.0"))]),
      {
        "z.last": ["2.0.0", "1.0.0"],
        "a.first": ["1.0.0"]
      }
    );

    await expect(tracker.readStatus({ appId: "app_1" })).resolves.toEqual([
      {
        hookName: "a.first",
        incompatibleInstallations: [],
        versions: [
          {
            version: "1.0.0",
            installationCount: 0,
            removable: true,
            blockingInstallations: []
          }
        ]
      },
      {
        hookName: "z.last",
        incompatibleInstallations: [],
        versions: [
          {
            version: "1.0.0",
            installationCount: 0,
            removable: true,
            blockingInstallations: []
          },
          {
            version: "2.0.0",
            installationCount: 0,
            removable: true,
            blockingInstallations: []
          }
        ]
      }
    ]);
  });

  it("fails retirement closed for incompatible ranges and unknown publications", async () => {
    const tracker = createD1SchemaMigrationTracker(
      databaseWithRows([installationRow("installation_v3", manifest("invoice.created", "^3.0.0"))]),
      { "invoice.created": ["1.0.0", "2.0.0"] }
    );

    await expect(
      tracker.assertVersionRemovable({
        appId: "app_1",
        hookName: "invoice.created",
        version: "1.0.0"
      })
    ).rejects.toEqual(
      new SchemaMigrationBlockedError("invoice.created@1.0.0 is still required by 1 installation", [
        "installation_v3"
      ])
    );
    await expect(
      tracker.assertVersionRemovable({
        appId: "app_1",
        hookName: "invoice.created",
        version: "3.0.0"
      })
    ).rejects.toThrow("published schema invoice.created@3.0.0 is not in the catalog");
  });

  it.each([
    ["not-json", "{"],
    ["invalid-manifest", JSON.stringify({ name: "broken" })]
  ])("redacts a stored %s", async (_label, manifestJson) => {
    const tracker = createD1SchemaMigrationTracker(
      databaseWithRows([
        {
          installation_id: "installation_1",
          plugin_key: "billing",
          plugin_version: "1.0.0",
          manifest_json: manifestJson
        }
      ]),
      { "invoice.created": ["1.0.0"] }
    );

    await expect(tracker.readStatus({ appId: "app_1" })).rejects.toThrow(
      "stored plugin manifest is invalid"
    );
  });
});

function databaseWithRows(rows: readonly Record<string, unknown>[]): D1DatabaseLike {
  return {
    prepare: () => ({
      bind: () => ({
        bind: () => {
          throw new Error("unexpected bind");
        },
        run: () => Promise.reject(new Error("unexpected run")),
        first: () => Promise.reject(new Error("unexpected first")),
        all: () => Promise.resolve({ results: [...rows] })
      }),
      run: () => Promise.reject(new Error("unexpected run")),
      first: () => Promise.reject(new Error("unexpected first")),
      all: () => Promise.reject(new Error("expected app binding"))
    })
  };
}

function installationRow(id: string, value: TenantScriptManifest): Record<string, unknown> {
  return {
    installation_id: id,
    plugin_key: "billing",
    plugin_version: value.version,
    manifest_json: JSON.stringify(value)
  };
}

function manifest(hookName: string, schemaVersionRange: string): TenantScriptManifest {
  return {
    name: "billing-plugin",
    version: "1.0.0",
    hooks: [{ name: hookName, type: "event", timeoutMs: 250, schemaVersionRange }],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}
