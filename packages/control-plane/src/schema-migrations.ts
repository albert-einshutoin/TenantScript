import { parseManifest } from "@tenantscript/manifest";
import { compare, maxSatisfying, prerelease, valid } from "semver";
import type { D1DatabaseLike } from "./storage.js";

export type PublishedHookSchemaCatalog = Readonly<Record<string, readonly string[]>>;

export interface SchemaMigrationBlocker {
  installationId: string;
  pluginKey: string;
  pluginVersion: string;
  schemaRange: string;
}

export interface SchemaMigrationVersionStatus {
  version: string;
  installationCount: number;
  removable: boolean;
  blockingInstallations: readonly SchemaMigrationBlocker[];
}

export interface SchemaMigrationStatus {
  hookName: string;
  versions: readonly SchemaMigrationVersionStatus[];
  incompatibleInstallations: readonly SchemaMigrationBlocker[];
}

export interface SchemaMigrationTracker {
  readStatus: (request: { appId: string }) => Promise<readonly SchemaMigrationStatus[]>;
  assertVersionRemovable: (request: {
    appId: string;
    hookName: string;
    version: string;
  }) => Promise<{ hookName: string; version: string; removable: true }>;
}

export class SchemaMigrationBlockedError extends Error {
  override readonly name = "SchemaMigrationBlockedError";

  constructor(
    message: string,
    readonly blockingInstallationIds: readonly string[]
  ) {
    super(message);
  }
}

export function createD1SchemaMigrationTracker(
  db: D1DatabaseLike,
  catalog: PublishedHookSchemaCatalog
): SchemaMigrationTracker {
  const normalizedCatalog = normalizePublishedHookSchemaCatalog(catalog);

  const readStatus = async (request: {
    appId: string;
  }): Promise<readonly SchemaMigrationStatus[]> => {
    // Disabled installations remain blockers because re-enabling them does not rewrite their
    // manifest; excluding them would allow a retired schema to break a valid future transition.
    const rows = await db
      .prepare(
        [
          "SELECT i.id AS installation_id, p.key AS plugin_key, pv.version AS plugin_version,",
          "pv.manifest_json",
          "FROM installations i",
          "JOIN plugin_versions pv ON pv.id = i.plugin_version_id",
          "JOIN plugins p ON p.id = pv.plugin_id",
          "JOIN tenants t ON t.id = i.tenant_id",
          "WHERE p.app_id = ?1 AND t.app_id = p.app_id",
          "ORDER BY i.id ASC"
        ].join(" ")
      )
      .bind(request.appId)
      .all();
    const installations = (rows.results as SchemaMigrationInstallationRow[]).map(
      schemaMigrationInstallation
    );

    return [...normalizedCatalog.entries()].map(([hookName, versions]) => {
      const blockersByVersion = new Map(
        versions.map((version) => [version, [] as SchemaMigrationBlocker[]])
      );
      const incompatibleInstallations: SchemaMigrationBlocker[] = [];
      for (const installation of installations) {
        const hook = installation.hooks.find((candidate) => candidate.name === hookName);
        if (hook === undefined) {
          continue;
        }
        const blocker = {
          installationId: installation.installationId,
          pluginKey: installation.pluginKey,
          pluginVersion: installation.pluginVersion,
          schemaRange: hook.schemaVersionRange
        };
        // Routing uses the highest compatible publication, so tracking must use the identical
        // choice or the retirement evidence can disagree with the payload an installation gets.
        const selectedVersion = maxSatisfying(versions, hook.schemaVersionRange);
        if (selectedVersion === null) {
          incompatibleInstallations.push(blocker);
          continue;
        }
        blockersByVersion.get(selectedVersion)?.push(blocker);
      }

      return {
        hookName,
        incompatibleInstallations,
        versions: versions.map((version) => {
          const blockingInstallations = blockersByVersion.get(version) ?? [];
          return {
            version,
            installationCount: blockingInstallations.length,
            removable: blockingInstallations.length === 0 && incompatibleInstallations.length === 0,
            blockingInstallations
          };
        })
      };
    });
  };

  return {
    readStatus,
    assertVersionRemovable: async (request) => {
      const hookVersions = normalizedCatalog.get(request.hookName);
      if (hookVersions === undefined || !hookVersions.includes(request.version)) {
        throw new Error(
          `published schema ${request.hookName}@${request.version} is not in the catalog`
        );
      }
      const statuses = await readStatus({ appId: request.appId });
      const hookStatus = statuses.find((status) => status.hookName === request.hookName);
      const versionStatus = hookStatus?.versions.find(
        (candidate) => candidate.version === request.version
      );
      if (hookStatus === undefined || versionStatus === undefined) {
        throw new Error(`schema migration status for ${request.hookName} is unavailable`);
      }
      const blockers = [
        ...versionStatus.blockingInstallations,
        ...hookStatus.incompatibleInstallations
      ];
      if (blockers.length > 0) {
        throw new SchemaMigrationBlockedError(
          `${request.hookName}@${request.version} is still required by ${String(blockers.length)} installation${blockers.length === 1 ? "" : "s"}`,
          blockers.map((blocker) => blocker.installationId)
        );
      }
      return { hookName: request.hookName, version: request.version, removable: true };
    }
  };
}

export function parsePublishedHookSchemaCatalog(input: unknown): PublishedHookSchemaCatalog {
  if (!isRecord(input)) {
    throw new Error("hook schema catalog must be an object");
  }
  const catalog: Record<string, readonly string[]> = {};
  for (const [hookName, versions] of Object.entries(input)) {
    if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
      throw new Error(`hook schema catalog entry ${hookName} must contain versions`);
    }
    catalog[hookName] = versions;
  }
  normalizePublishedHookSchemaCatalog(catalog);
  return catalog;
}

function normalizePublishedHookSchemaCatalog(
  catalog: PublishedHookSchemaCatalog
): ReadonlyMap<string, readonly string[]> {
  const normalized = new Map<string, readonly string[]>();
  for (const [hookName, versions] of Object.entries(catalog).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (hookName.trim() !== hookName || hookName.length === 0 || versions.length === 0) {
      throw new Error("hook schema catalog entries must not be empty");
    }
    if (versions.some((version) => valid(version) === null)) {
      throw new Error(`hook schema catalog entry ${hookName} contains an invalid version`);
    }
    if (versions.some((version) => prerelease(version) !== null)) {
      throw new Error(`hook schema catalog entry ${hookName} contains a prerelease version`);
    }
    if (new Set(versions).size !== versions.length) {
      throw new Error(`hook schema catalog entry ${hookName} contains duplicate versions`);
    }
    normalized.set(hookName, [...versions].sort(compare));
  }
  return normalized;
}

function schemaMigrationInstallation(row: SchemaMigrationInstallationRow): {
  installationId: string;
  pluginKey: string;
  pluginVersion: string;
  hooks: readonly { name: string; schemaVersionRange: string }[];
} {
  let manifestInput: unknown;
  try {
    manifestInput = JSON.parse(row.manifest_json);
  } catch {
    throw new Error("stored plugin manifest is invalid");
  }
  const parsed = parseManifest(manifestInput);
  if (!parsed.ok) {
    throw new Error("stored plugin manifest is invalid");
  }
  return {
    installationId: row.installation_id,
    pluginKey: row.plugin_key,
    pluginVersion: row.plugin_version,
    hooks: parsed.value.hooks.map((hook) => ({
      name: hook.name,
      schemaVersionRange: hook.schemaVersionRange
    }))
  };
}

interface SchemaMigrationInstallationRow {
  installation_id: string;
  plugin_key: string;
  plugin_version: string;
  manifest_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
