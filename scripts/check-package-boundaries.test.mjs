import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-package-boundaries.mjs");
const repoRoot = join(dirname(scriptPath), "..");

function runChecker(repoDir) {
  return spawnSync(process.execPath, [scriptPath, repoDir], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function withTempRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "package-boundaries-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeManifest(
  dir,
  workspacePath,
  dependencies = {},
  name = `@tenantscript/${workspacePath.split("/").at(-1)}`
) {
  const path = join(dir, workspacePath, "package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ name, dependencies })}\n`);
}

test("rejects a low-level manifest dependency on the control plane", () => {
  withTempRepo((dir) => {
    writeManifest(dir, "packages/manifest", {
      "@tenantscript/control-plane": "workspace:*"
    });
    writeManifest(dir, "packages/control-plane");

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /packages\/manifest\/package\.json: @tenantscript\/manifest must not depend on @tenantscript\/control-plane/
    );
  });
});

test("rejects undeclared internal packages instead of silently allowing a new edge", () => {
  withTempRepo((dir) => {
    writeManifest(dir, "packages/control-plane", {
      "@tenantscript/unknown-runtime": "workspace:*"
    });

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown internal package @tenantscript\/unknown-runtime/);
  });
});

test("rejects app-to-app dependencies so composition roots cannot form cycles", () => {
  withTempRepo((dir) => {
    writeManifest(dir, "apps/admin-ui", {
      "@tenantscript/example-saas": "workspace:*"
    });
    writeManifest(dir, "apps/example-saas");

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /apps\/admin-ui\/package\.json: @tenantscript\/admin-ui must not depend on app @tenantscript\/example-saas/
    );
  });
});

test("rejects an unreviewed deploy-image dependency", () => {
  withTempRepo((dir) => {
    writeManifest(dir, "packages/plugin-sdk");
    writeManifest(
      dir,
      "deploy/plugin-authoring-judge",
      { "@tenantscript/plugin-sdk": "workspace:*" },
      "@tenantscript/plugin-authoring-judge-image"
    );

    const result = runChecker(dir);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /deploy\/plugin-authoring-judge\/package\.json: @tenantscript\/plugin-authoring-judge-image must not depend on @tenantscript\/plugin-sdk/
    );
  });
});

test("accepts the documented runtime graph and app composition roots", () => {
  withTempRepo((dir) => {
    writeManifest(dir, "packages/manifest");
    writeManifest(dir, "packages/host-sdk");
    writeManifest(dir, "packages/plugin-sdk", { "@tenantscript/manifest": "workspace:*" });
    writeManifest(dir, "packages/control-plane", {
      "@tenantscript/manifest": "workspace:*",
      "@tenantscript/host-sdk": "workspace:*"
    });
    writeManifest(dir, "packages/loader", {
      "@tenantscript/control-plane": "workspace:*"
    });
    writeManifest(dir, "packages/cli");
    writeManifest(dir, "apps/example-saas", {
      "@tenantscript/control-plane": "workspace:*",
      "@tenantscript/loader": "workspace:*"
    });
    writeManifest(
      dir,
      "deploy/plugin-authoring-judge",
      {
        "@tenantscript/cli": "workspace:*",
        "@tenantscript/loader": "workspace:*",
        "@tenantscript/manifest": "workspace:*"
      },
      "@tenantscript/plugin-authoring-judge-image"
    );

    const result = runChecker(dir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Package boundary check passed/);
  });
});
