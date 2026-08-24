import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { verifyNpmScope } from "./npm-scope-verification.mjs";
import { validateReleaseCandidate } from "./release-preflight.mjs";

const publicPackageNames = [
  "@tenantscript/capabilities",
  "@tenantscript/cli",
  "@tenantscript/control-plane",
  "@tenantscript/host-sdk",
  "@tenantscript/loader",
  "@tenantscript/manifest",
  "@tenantscript/plugin-sdk",
  "@tenantscript/proxy"
];

function approvedReadiness() {
  return {
    schemaVersion: 1,
    kind: "tenantscript-v1-launch-readiness",
    repository: "albert-einshutoin/TenantScript",
    targetVersion: "1.0.0",
    gates: {
      productionAdopters: {
        required: 5,
        verified: 5,
        evidence: ["ADOPTERS.md"]
      },
      externalContributors: {
        required: 10,
        verified: 10,
        evidence: ["docs/releases/v1-external-contributors.md"]
      },
      advisoryResponses: {
        required: 1,
        verified: 1,
        evidence: ["docs/releases/v1-advisory-response.md"]
      },
      externalSecurityReview: {
        completed: true,
        criticalOpen: 0,
        highOpen: 0,
        evidence: ["https://example.org/tenantscript-security-review"]
      },
      selfHostValidators: {
        required: 2,
        verified: 2,
        evidence: ["docs/operations/self-host-production.md"]
      },
      releaseBlockers: {
        openIssues: [],
        evidence: ["docs/releases/v1-blocker-triage.md"]
      },
      releaseMaterials: {
        changelog: true,
        announcement: true,
        evidence: ["CHANGELOG.md", "docs/releases/v1-announcement.md"]
      }
    },
    decision: {
      status: "approved",
      blockers: []
    }
  };
}

test("accepts a stable tag matching every fixed public package", () => {
  assert.deepEqual(
    validateReleaseCandidate({
      tag: "v1.2.3",
      packages: publicPackageNames.map((name) => ({ name, version: "1.2.3" })),
      changesetFiles: ["README.md"],
      v1Readiness: approvedReadiness()
    }),
    {
      tag: "v1.2.3",
      version: "1.2.3",
      packages: publicPackageNames,
      readiness: { targetVersion: "1.0.0", status: "approved" }
    }
  );
});

test("fails closed for tag, version, package-set, and pending Changeset drift", () => {
  const valid = {
    tag: "v1.2.3",
    packages: publicPackageNames.map((name) => ({ name, version: "1.2.3" })),
    changesetFiles: ["README.md"],
    v1Readiness: approvedReadiness()
  };

  assert.throws(
    () => validateReleaseCandidate({ ...valid, tag: "v1.2.4" }),
    /tag v1\.2\.4 does not match package version 1\.2\.3/u
  );
  assert.throws(
    () =>
      validateReleaseCandidate({
        ...valid,
        packages: valid.packages.map((entry, index) =>
          index === 0 ? { ...entry, version: "1.2.4" } : entry
        )
      }),
    /public package versions must match/u
  );
  assert.throws(
    () => validateReleaseCandidate({ ...valid, tag: "v0.0.0", packages: versioned("0.0.0") }),
    /0\.0\.0 cannot be published/u
  );
  assert.throws(
    () => validateReleaseCandidate({ ...valid, packages: valid.packages.slice(1) }),
    /public package set does not match/u
  );
  assert.throws(
    () => validateReleaseCandidate({ ...valid, changesetFiles: ["README.md", "pending.md"] }),
    /release candidate contains unconsumed Changesets/u
  );
  assert.throws(
    () => validateReleaseCandidate({ ...valid, tag: "v1.2.3-beta.1" }),
    /stable release tag/u
  );
});

test("keeps 0.x available and fails closed at unsupported major release boundaries", () => {
  assert.deepEqual(
    validateReleaseCandidate({
      tag: "v0.9.0",
      packages: versioned("0.9.0"),
      changesetFiles: ["README.md"]
    }),
    { tag: "v0.9.0", version: "0.9.0", packages: publicPackageNames }
  );

  assert.throws(
    () =>
      validateReleaseCandidate({
        tag: "v1.0.0",
        packages: versioned("1.0.0"),
        changesetFiles: ["README.md"]
      }),
    /v1 launch readiness record is invalid/u
  );

  const blocked = approvedReadiness();
  blocked.gates.productionAdopters.verified = 4;
  blocked.decision = {
    status: "blocked",
    blockers: ["production-adopters"]
  };
  assert.throws(
    () =>
      validateReleaseCandidate({
        tag: "v1.0.0",
        packages: versioned("1.0.0"),
        changesetFiles: ["README.md"],
        v1Readiness: blocked
      }),
    /v1 launch readiness is not approved/u
  );

  assert.throws(
    () =>
      validateReleaseCandidate({
        tag: "v2.0.0",
        packages: versioned("2.0.0"),
        changesetFiles: ["README.md"]
      }),
    /major release requires a dedicated readiness gate/u
  );
});

test("release PR and publish workflows preserve the no-token OIDC boundary", async () => {
  const [releasePr, publish, tier1, guide] = await Promise.all([
    readFile(new URL("../.github/workflows/release-pr.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/tier1.yml", import.meta.url), "utf8"),
    readFile(new URL("../docs/reference/release-automation.md", import.meta.url), "utf8")
  ]);

  assert.match(
    releasePr,
    /changesets\/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d # v1\.9\.0/u
  );
  assert.match(releasePr, /version:\s*pnpm changeset:version/u);
  assert.match(releasePr, /vars\.RELEASE_AUTOMATION_ENABLED == 'true'/u);
  assert.doesNotMatch(releasePr, /publish:/u);

  assert.match(publish, /tags:\s*\n\s*- "v\*"/u);
  assert.match(publish, /id-token:\s*write/u);
  assert.match(publish, /environment:\s*npm-publish/u);
  assert.match(publish, /vars\.NPM_TRUSTED_PUBLISHING_ENABLED == 'true'/u);
  assert.match(publish, /runs-on:\s*ubuntu-latest/u);
  assert.match(publish, /node-version:\s*24/u);
  assert.match(publish, /package-manager-cache:\s*false/u);
  assert.match(publish, /git merge-base --is-ancestor/u);
  assert.match(publish, /node scripts\/release-preflight\.mjs/u);
  assert.match(publish, /pnpm verify/u);
  assert.match(publish, /pnpm pack:check/u);
  assert.match(publish, /pnpm sbom:generate/u);
  assert.match(publish, /pnpm changeset publish/u);
  assert.match(publish, /git push origin --tags/u);
  assert.match(publish, /gh release create/u);
  assert.doesNotMatch(publish, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.match(tier1, /pnpm test:release-automation/u);
  assert.match(guide, /Repository verified \/ Blocked/u);
  assert.match(guide, /初回.*bootstrap/su);
  assert.match(guide, /provenance/u);
  assert.match(guide, /再実行/u);
});

test("npm scope verification is manual, read-only, and isolated from publishing", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/npm-scope-verify.yml", import.meta.url),
    "utf8"
  );
  const guide = await readFile(
    new URL("../docs/reference/release-automation.md", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|schedule):/mu);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/u);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /secrets\.NPM_TOKEN/u);
  assert.match(workflow, /node scripts\/npm-scope-verification\.mjs/u);
  assert.match(workflow, /actions\/upload-artifact@v6/u);
  assert.doesNotMatch(workflow, /npm publish|changeset publish|id-token:\s*write/u);
  assert.match(guide, /NPM_TOKEN/u);
  assert.match(guide, /organization.*package\/scope.*read-only/su);
  assert.match(guide, /publish可能なtoken.*使っては\s*いけません/su);
  assert.match(guide, /Issue #3.*ADR-002.*Phase0 task/su);
});

test("npm scope verification accepts owner membership and closed package states", async () => {
  const commands = [];
  const result = await verifyNpmScope({
    rootDirectory: fileURLToPath(new URL("..", import.meta.url)),
    executeNpm: async (args) => {
      commands.push(args);
      if (args[0] === "whoami") return npmResult(0, "maintainer\n");
      if (args[0] === "org") return npmResult(0, '{"maintainer":"owner"}');
      const packageName = args[1];
      return packageName === "@tenantscript/cli"
        ? npmResult(0, JSON.stringify(packageName))
        : npmResult(1, "", "npm error code E404");
    }
  });

  assert.equal(result.actor, "maintainer");
  assert.equal(result.role, "owner");
  assert.equal(result.packages.length, 8);
  assert.deepEqual(
    result.packages.find(({ name }) => name === "@tenantscript/cli"),
    { name: "@tenantscript/cli", status: "published" }
  );
  assert.ok(
    commands.every((args) => !args.includes("publish") && !args.join(" ").includes("token"))
  );
});

test("npm scope verification fails closed without reflecting registry errors", async () => {
  const secret = "secret-sentinel-provider-error";
  await assert.rejects(
    verifyNpmScope({
      rootDirectory: fileURLToPath(new URL("..", import.meta.url)),
      executeNpm: async (args) =>
        args[0] === "whoami" ? npmResult(0, "maintainer\n") : npmResult(1, "", secret)
    }),
    (error) => {
      assert.equal(error.message, "npm scope ownership verification failed");
      assert.doesNotMatch(error.message, /secret-sentinel/u);
      return true;
    }
  );
});

function npmResult(code, stdout = "", stderr = "") {
  return { code, stdout, stderr };
}

function versioned(version) {
  return publicPackageNames.map((name) => ({ name, version }));
}
