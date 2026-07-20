import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createValidatedPackageArtifacts,
  discoverPublicPackages,
  sanitizePackageManagerEnvironment
} from "./publishable-packages.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenDevelopmentPackages = [
  "@changesets/cli",
  "@cyclonedx/cyclonedx-npm",
  "@playwright/test",
  "typescript",
  "vitest"
];

export function validateReleaseSbom(sbom, contract) {
  const errors = [];
  if (!isRecord(sbom) || sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6") {
    throw new Error("Release SBOM must be CycloneDX 1.6 JSON");
  }
  if (!isRecord(sbom.metadata) || !isComponent(sbom.metadata.component)) {
    throw new Error("Release SBOM metadata component is invalid");
  }
  const root = sbom.metadata.component;
  if (root.type !== "application" || root.name !== "tenantscript-platform") {
    errors.push("metadata component must be the tenantscript-platform application");
  }
  const components = Array.isArray(sbom.components) ? sbom.components : [];
  const validComponents = components.filter(isComponent);
  if (validComponents.length !== components.length) errors.push("malformed component");

  const names = new Set(validComponents.map(componentName));
  for (const packageName of contract.expectedPackages) {
    if (!names.has(packageName)) errors.push(`missing release component ${packageName}`);
  }
  for (const packageName of contract.requiredRuntimePackages) {
    if (!names.has(packageName)) errors.push(`missing runtime component ${packageName}`);
  }
  for (const packageName of contract.forbiddenPackages) {
    if (names.has(packageName)) errors.push(`forbidden development component ${packageName}`);
  }

  const refs = [root["bom-ref"], ...validComponents.map((component) => component["bom-ref"])];
  const seenRefs = new Set();
  for (const ref of refs) {
    if (seenRefs.has(ref)) errors.push(`duplicate bom-ref ${ref}`);
    seenRefs.add(ref);
  }
  for (const component of validComponents) {
    if (
      component.hashes !== undefined &&
      (!Array.isArray(component.hashes) ||
        component.hashes.some(
          (hash) =>
            !isRecord(hash) || typeof hash.content !== "string" || hash.content.trim() === ""
        ))
    ) {
      errors.push(`empty component hash ${componentName(component)}`);
    }
  }

  const dependencies = Array.isArray(sbom.dependencies) ? sbom.dependencies : [];
  const graph = new Map();
  for (const dependency of dependencies) {
    if (
      !isRecord(dependency) ||
      typeof dependency.ref !== "string" ||
      (dependency.dependsOn !== undefined && !Array.isArray(dependency.dependsOn)) ||
      (Array.isArray(dependency.dependsOn) &&
        dependency.dependsOn.some((ref) => typeof ref !== "string"))
    ) {
      errors.push("malformed dependency edge");
      continue;
    }
    if (graph.has(dependency.ref)) errors.push(`duplicate dependency node ${dependency.ref}`);
    if (!seenRefs.has(dependency.ref)) errors.push(`unknown dependency node ${dependency.ref}`);
    for (const dependencyRef of dependency.dependsOn ?? []) {
      if (!seenRefs.has(dependencyRef)) {
        errors.push(`unknown dependency reference ${dependencyRef}`);
      }
    }
    graph.set(dependency.ref, dependency.dependsOn ?? []);
  }
  const reachable = collectReachableRefs(root["bom-ref"], graph);
  for (const component of validComponents) {
    if (!graph.has(component["bom-ref"])) {
      errors.push(`missing dependency node ${componentName(component)}`);
    }
    if (!reachable.has(component["bom-ref"])) {
      errors.push(`unreachable component ${componentName(component)}`);
    }
  }

  const forbiddenValues = collectForbiddenValues(sbom, contract.forbiddenValuePatterns);
  if (forbiddenValues.length > 0) {
    errors.push(`forbidden SBOM value at ${forbiddenValues.join(", ")}`);
  }
  if (errors.length > 0) {
    throw new Error(
      `Release SBOM validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }
}

export async function generateReleaseSbom(rootDirectory, outputFile) {
  const root = resolve(rootDirectory);
  const output = resolve(outputFile);
  await mkdir(join(root, ".tmp"), { recursive: true });
  await assertSafeReleaseOutputPath(root, output);
  try {
    await access(output);
    throw new Error(`Release SBOM output already exists: ${relative(root, output)}`);
  } catch (error) {
    if (!(error instanceof Error) || !Object.hasOwn(error, "code") || error.code !== "ENOENT") {
      throw error;
    }
  }

  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packages = await discoverPublicPackages(root);
  const temporaryDirectory = await mkdtemp(join(root, ".tmp", "release-sbom-"));
  try {
    const packageDirectory = join(temporaryDirectory, "packages");
    const { archives } = await createValidatedPackageArtifacts(root, packageDirectory);
    const consumerDirectory = join(temporaryDirectory, "consumer");
    await mkdir(consumerDirectory, { recursive: true });
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "tenantscript-platform",
          version: rootManifest.version,
          private: true,
          dependencies: Object.fromEntries(
            packages.map(({ name }, index) => [name, `file:${archives[index]}`])
          )
        },
        null,
        2
      )}\n`
    );
    const environment = {
      ...sanitizePackageManagerEnvironment(process.env),
      BOM_REPRODUCIBLE: "1",
      NODE_ENV: "production",
      HOME: consumerDirectory,
      USERPROFILE: consumerDirectory
    };
    const npmCli = join(root, "node_modules", "npm", "bin", "npm-cli.js");
    environment.npm_execpath = npmCli;
    await run(
      process.execPath,
      [
        npmCli,
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--update-notifier=false"
      ],
      consumerDirectory,
      environment,
      "Release SBOM dependency lock generation failed"
    );
    const rawOutput = join(temporaryDirectory, "tenantscript.cdx.json");
    await run(
      join(root, "node_modules", ".bin", "cyclonedx-npm"),
      [
        "--package-lock-only",
        "--omit",
        "dev",
        "--output-reproducible",
        "--flatten-components",
        "--spec-version",
        "1.6",
        "--output-format",
        "JSON",
        "--output-file",
        rawOutput,
        "--validate",
        "--mc-type",
        "application",
        join(consumerDirectory, "package.json")
      ],
      consumerDirectory,
      environment,
      "Release SBOM generation failed"
    );
    const bytes = await readFile(rawOutput);
    const sbom = JSON.parse(bytes.toString("utf8"));
    validateReleaseSbom(sbom, {
      expectedPackages: packages.map(({ name }) => name),
      requiredRuntimePackages: ["esbuild", "semver", "zod"],
      forbiddenPackages: forbiddenDevelopmentPackages,
      forbiddenValuePatterns: [
        /(?:^|[\\/])(?:Users|Volumes|home|private|tmp)[\\/]/u,
        /(?:credential|npm[_-]?token|secret|_authToken)/iu
      ]
    });
    await mkdir(dirname(output), { recursive: true });
    await copyFile(rawOutput, output, constants.COPYFILE_EXCL);
    return sbom;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function assertSafeReleaseOutputPath(rootDirectory, outputFile) {
  const root = resolve(rootDirectory);
  const output = resolve(outputFile);
  const temporaryRoot = resolve(root, ".tmp");
  const path = relative(temporaryRoot, output);
  if (path === "" || path.startsWith("..") || path.includes("\0")) {
    throw new Error("Release SBOM output must be inside repository .tmp");
  }
  const directories = [temporaryRoot];
  let current = temporaryRoot;
  for (const segment of relative(temporaryRoot, dirname(output)).split(sep)) {
    if (segment === "") continue;
    current = join(current, segment);
    directories.push(current);
  }
  for (const directory of directories) {
    try {
      if ((await lstat(directory)).isSymbolicLink()) {
        throw new Error("Release SBOM output path must not contain a symlink");
      }
    } catch (error) {
      if (error instanceof Error && Object.hasOwn(error, "code") && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function run(command, args, cwd, environment, failureMessage) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", () => reject(new Error(failureMessage)));
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(failureMessage));
    });
  });
}

function collectReachableRefs(rootRef, graph) {
  const reachable = new Set();
  const pending = [rootRef];
  while (pending.length > 0) {
    const ref = pending.pop();
    if (ref === undefined || reachable.has(ref)) continue;
    reachable.add(ref);
    pending.push(...(graph.get(ref) ?? []));
  }
  return reachable;
}

function collectForbiddenValues(value, patterns, path = "$", found = []) {
  if (typeof value === "string") {
    if (patterns.some((pattern) => pattern.test(value))) found.push(path);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectForbiddenValues(entry, patterns, `${path}[${index}]`, found)
    );
    return found;
  }
  if (isRecord(value)) {
    const recordPath =
      typeof value.name === "string" && Object.hasOwn(value, "value")
        ? `${path}[${value.name}]`
        : path;
    for (const [key, entry] of Object.entries(value)) {
      if (patterns.some((pattern) => pattern.test(key))) found.push(`${recordPath}.${key}`);
      collectForbiddenValues(entry, patterns, `${recordPath}.${key}`, found);
    }
  }
  return found;
}

function isComponent(value) {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value["bom-ref"] === "string" &&
    value["bom-ref"] !== ""
  );
}

function componentName(component) {
  return typeof component.group === "string" && component.group !== ""
    ? `${component.group}/${component.name}`
    : component.name;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main() {
  const [command, output] = process.argv.slice(2);
  if (command !== "generate" || output === undefined || process.argv.length !== 4) {
    throw new Error("Usage: release-sbom.mjs generate <output-file>");
  }
  await generateReleaseSbom(defaultRoot, resolve(defaultRoot, output));
  console.log(
    `Validated release SBOM written to ${relative(defaultRoot, resolve(defaultRoot, output))}.`
  );
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Release SBOM command failed");
    process.exitCode = 1;
  });
}
