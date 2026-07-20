import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertSafeReleaseOutputPath,
  generateReleaseSbom,
  validateReleaseSbom
} from "./release-sbom.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

const publicPackages = [
  "@tenantscript/capabilities",
  "@tenantscript/cli",
  "@tenantscript/control-plane",
  "@tenantscript/host-sdk",
  "@tenantscript/loader",
  "@tenantscript/manifest",
  "@tenantscript/plugin-sdk",
  "@tenantscript/proxy"
];

test("accepts a reachable CycloneDX graph for every release package and runtime dependency", () => {
  assert.doesNotThrow(() => validateReleaseSbom(validSbom(), validationContract()));
});

test("rejects a release package missing from the SBOM", () => {
  const sbom = validSbom();
  sbom.components = sbom.components.filter(({ name }) => name !== "@tenantscript/proxy");

  assert.throws(
    () => validateReleaseSbom(sbom, validationContract()),
    /missing release component @tenantscript\/proxy/u
  );
});

test("rejects unreachable components and duplicate bom refs", () => {
  const sbom = validSbom();
  sbom.components.push(
    { type: "library", name: "duplicate-zod", version: "1.0.0", "bom-ref": "zod" },
    { type: "library", name: "orphan", version: "1.0.0", "bom-ref": "orphan" }
  );

  assert.throws(
    () => validateReleaseSbom(sbom, validationContract()),
    /duplicate bom-ref zod.*unreachable component/su
  );
});

test("rejects development tools from a production release SBOM", () => {
  const sbom = validSbom();
  sbom.components.push({
    type: "library",
    name: "typescript",
    version: "5.9.3",
    "bom-ref": "typescript"
  });
  sbom.dependencies[0].dependsOn.push("typescript");
  sbom.dependencies.push({ ref: "typescript", dependsOn: [] });

  assert.throws(
    () => validateReleaseSbom(sbom, validationContract()),
    /forbidden development component typescript/u
  );
});

test("rejects machine paths and credential-shaped values", () => {
  const sbom = validSbom();
  sbom.metadata.properties = [
    { name: "install-path", value: "/Volumes/private/release" },
    { name: "npm-token", value: "npm_fixture_secret" }
  ];

  assert.throws(
    () => validateReleaseSbom(sbom, validationContract()),
    /forbidden SBOM value.*install-path.*npm-token/su
  );
});

test("rejects empty hashes and dependency references without components", () => {
  const sbom = validSbom();
  sbom.components[0].hashes = [{ alg: "SHA-256", content: "" }];
  sbom.dependencies[0].dependsOn.push("missing-component");

  assert.throws(
    () => validateReleaseSbom(sbom, validationContract()),
    /empty component hash.*unknown dependency reference missing-component/su
  );
});

test("generates byte-identical validated SBOMs from release tarballs", async () => {
  await mkdir(join(repositoryRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(repositoryRoot, ".tmp", "sbom-test-"));
  const first = join(directory, "first.cdx.json");
  const second = join(directory, "second.cdx.json");
  try {
    await generateReleaseSbom(repositoryRoot, first);
    await generateReleaseSbom(repositoryRoot, second);
    const [firstBytes, secondBytes] = await Promise.all([readFile(first), readFile(second)]);
    assert.deepEqual(firstBytes, secondBytes);
    validateReleaseSbom(JSON.parse(firstBytes.toString("utf8")), validationContract());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite an existing release artifact", async () => {
  await mkdir(join(repositoryRoot, ".tmp"), { recursive: true });
  const directory = await mkdtemp(join(repositoryRoot, ".tmp", "sbom-existing-"));
  const output = join(directory, "release.cdx.json");
  try {
    await writeFile(output, "maintainer-owned\n");
    await assert.rejects(generateReleaseSbom(repositoryRoot, output), /already exists/u);
    assert.equal(await readFile(output, "utf8"), "maintainer-owned\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a symlink that redirects the artifact outside repository tmp", async () => {
  await mkdir(join(repositoryRoot, ".tmp"), { recursive: true });
  const outside = await mkdtemp(join(tmpdir(), "tenantscript-sbom-outside-"));
  const link = join(repositoryRoot, ".tmp", `sbom-link-${outside.split("/").at(-1)}`);
  try {
    await symlink(outside, link);
    await assert.rejects(
      assertSafeReleaseOutputPath(repositoryRoot, join(link, "release.cdx.json")),
      /symlink/u
    );
  } finally {
    await rm(link, { force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function validationContract() {
  return {
    expectedPackages: publicPackages,
    requiredRuntimePackages: ["semver", "zod", "esbuild"],
    forbiddenPackages: ["@changesets/cli", "@cyclonedx/cyclonedx-npm", "typescript", "vitest"],
    forbiddenValuePatterns: [/\/Volumes\//u, /(?:token|secret)/iu]
  };
}

function validSbom() {
  const packageComponents = publicPackages.map((name) => ({
    type: "library",
    name,
    version: "0.0.0",
    "bom-ref": name
  }));
  const runtimeComponents = ["semver", "zod", "esbuild"].map((name) => ({
    type: "library",
    name,
    version: "1.0.0",
    "bom-ref": name
  }));
  const componentRefs = [...packageComponents, ...runtimeComponents].map(
    (component) => component["bom-ref"]
  );
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "tenantscript-platform",
        version: "0.0.0",
        "bom-ref": "tenantscript-platform"
      }
    },
    components: [...packageComponents, ...runtimeComponents],
    dependencies: [
      { ref: "tenantscript-platform", dependsOn: componentRefs },
      ...componentRefs.map((ref) => ({ ref, dependsOn: [] }))
    ]
  };
}
