import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "check-package-license-metadata.mjs"
);
const repoRoot = join(dirname(scriptPath), "..");

function runChecker(repoDir) {
  return spawnSync(process.execPath, [scriptPath, repoDir], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function withTempRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), "license-lint-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePackageJson(dir, relativePath, manifest) {
  const filePath = join(dir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("reports package path and missing license field", () => {
  withTempRepo((dir) => {
    writePackageJson(dir, "package.json", { name: "root", private: true });
    writePackageJson(dir, "packages/foo/package.json", { name: "foo" });

    const result = runChecker(dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package\.json: missing license field/);
    assert.match(result.stderr, /packages\/foo\/package\.json: missing license field/);
  });
});

test("reports package path and incorrect license field", () => {
  withTempRepo((dir) => {
    writePackageJson(dir, "package.json", {
      name: "root",
      private: true,
      license: "Apache-2.0"
    });
    writePackageJson(dir, "apps/bar/package.json", {
      name: "bar",
      license: "MIT"
    });

    const result = runChecker(dir);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /apps\/bar\/package\.json: incorrect license field "MIT" \(expected "Apache-2.0"\)/
    );
  });
});

test("passes when root, packages, and apps declare Apache-2.0", () => {
  withTempRepo((dir) => {
    writePackageJson(dir, "package.json", {
      name: "root",
      private: true,
      license: "Apache-2.0"
    });
    writePackageJson(dir, "packages/foo/package.json", {
      name: "foo",
      license: "Apache-2.0"
    });
    writePackageJson(dir, "apps/bar/package.json", {
      name: "bar",
      license: "Apache-2.0"
    });

    const result = runChecker(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 packages/);
  });
});

test("skips packages and apps directories when absent", () => {
  withTempRepo((dir) => {
    writePackageJson(dir, "package.json", {
      name: "root",
      private: true,
      license: "Apache-2.0"
    });

    const result = runChecker(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 packages/);
  });
});

test("ignores workspace children without package.json", () => {
  withTempRepo((dir) => {
    writePackageJson(dir, "package.json", {
      name: "root",
      private: true,
      license: "Apache-2.0"
    });
    mkdirSync(join(dir, "packages", "empty-dir"), { recursive: true });

    const result = runChecker(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 packages/);
  });
});
