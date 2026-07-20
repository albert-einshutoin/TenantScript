import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function discoverPublicPackages(rootDirectory) {
  const root = resolve(rootDirectory);
  const packagesRoot = join(root, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(packagesRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(manifest) || manifest.private === true || typeof manifest.name !== "string") {
      continue;
    }
    packages.push({
      name: manifest.name,
      directory,
      relativeDirectory: relative(root, directory),
      manifest,
      exportTargets: collectExportTargets(manifest.exports),
      binTargets: collectBinTargets(manifest.bin)
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

export async function validateRepositoryPackageContracts(rootDirectory) {
  const packages = await discoverPublicPackages(rootDirectory);
  const errors = [];
  for (const packageContract of packages) {
    const { manifest, relativeDirectory } = packageContract;
    if (!Array.isArray(manifest.files) || !hasExactStrings(manifest.files, ["dist"])) {
      errors.push(`${relativeDirectory}/package.json: files must be exactly ["dist"]`);
    }
    if (!isRecord(manifest.scripts) || manifest.scripts.build !== "tsc -p tsconfig.build.json") {
      errors.push(`${relativeDirectory}/package.json: missing source-only build script`);
    }
    if (
      !isRecord(manifest.publishConfig) ||
      manifest.publishConfig.access !== "public" ||
      manifest.publishConfig.provenance !== true
    ) {
      errors.push(`${relativeDirectory}/package.json: public provenance publishConfig is required`);
    }
    try {
      await access(join(packageContract.directory, "tsconfig.build.json"));
    } catch {
      errors.push(`${relativeDirectory}/tsconfig.build.json: build config is required`);
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Publishable package contract failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }
}

export async function buildPublicPackages(rootDirectory) {
  const root = resolve(rootDirectory);
  await validateRepositoryPackageContracts(root);
  await cleanupPublicPackageArtifacts(root);
  // Build one workspace at a time in dependency order so each package resolves the declarations
  // emitted by its internal dependencies instead of copying another workspace's source tree.
  await run(
    "pnpm",
    [
      "-r",
      "--workspace-concurrency=1",
      "--filter",
      "./packages/**",
      "--if-present",
      "run",
      "build"
    ],
    root,
    "Public package build failed",
    sanitizePackageManagerEnvironment(process.env)
  );
}

export async function cleanupPublicPackageArtifacts(rootDirectory) {
  const packages = await discoverPublicPackages(rootDirectory);
  await Promise.all(
    packages.map(({ directory }) => rm(join(directory, "dist"), { recursive: true, force: true }))
  );
}

export function validatePackedPackage(packageContract, packResult) {
  if (!isRecord(packResult) || !Array.isArray(packResult.files)) {
    throw new Error(`Packed package ${packageContract.name} is invalid: malformed pack result`);
  }
  const paths = packResult.files
    .flatMap((file) => (isRecord(file) && typeof file.path === "string" ? [file.path] : []))
    .sort();
  const errors = [];
  const forbidden = paths.filter(
    (path) => !isAllowedPackedPath(path) || isSensitivePackedPath(path)
  );
  errors.push(...forbidden.map((path) => `forbidden file ${path}`));
  for (const required of [
    "package.json",
    "LICENSE",
    "README.md",
    ...packageContract.exportTargets,
    ...packageContract.binTargets
  ]) {
    if (!paths.includes(required)) errors.push(`missing declared target ${required}`);
  }
  if (errors.length > 0) {
    throw new Error(`Packed package ${packageContract.name} is invalid:\n${errors.join("\n")}`);
  }
}

export async function packAndValidatePublicPackages(rootDirectory) {
  const root = resolve(rootDirectory);
  const archiveDirectory = join(root, ".tmp", "npm-packages");
  const packages = await discoverPublicPackages(root);
  await rm(archiveDirectory, { recursive: true, force: true });
  await mkdir(archiveDirectory, { recursive: true });
  try {
    await buildPublicPackages(root);
    const inventory = [];
    const archives = [];
    for (const packageContract of packages) {
      const output = await runCapture(
        "pnpm",
        ["--silent", "pack", "--json", "--pack-destination", archiveDirectory],
        packageContract.directory,
        sanitizePackageManagerEnvironment(process.env)
      );
      const parsed = parseJsonSuffix(output);
      const packResult = Array.isArray(parsed) ? parsed[0] : parsed;
      validatePackedPackage(packageContract, packResult);
      const unpackedSize = await calculateUnpackedSize(root, packageContract, packResult.files);
      const archive = await packedArchive(archiveDirectory, packResult);
      if (
        !isRecord(packResult) ||
        unpackedSize <= 0 ||
        unpackedSize > 1024 * 1024 ||
        archive.size <= 0 ||
        archive.size > 512 * 1024 ||
        !Array.isArray(packResult.files) ||
        packResult.files.length > 200
      ) {
        throw new Error(`Packed package ${packageContract.name} exceeds the release budget`);
      }
      inventory.push({
        name: packageContract.name,
        fileCount: packResult.files.length,
        packedSize: archive.size,
        unpackedSize
      });
      archives.push(archive.path);
    }
    await smokeInstallPackedPackages(root, packages, archives);
    return inventory.map((entry) => ({
      ...entry,
      smokeVerified: true,
      typesVerified: true
    }));
  } finally {
    await cleanupPublicPackageArtifacts(root);
    await rm(archiveDirectory, { recursive: true, force: true });
  }
}

function collectExportTargets(exportsField) {
  if (!isRecord(exportsField)) return [];
  return [...new Set(Object.values(exportsField).flatMap((value) => nestedStrings(value)))]
    .map(normalizeTarget)
    .sort();
}

function collectBinTargets(binField) {
  if (typeof binField === "string") return [normalizeTarget(binField)];
  if (!isRecord(binField)) return [];
  return [...new Set(Object.values(binField).filter((value) => typeof value === "string"))]
    .map(normalizeTarget)
    .sort();
}

function nestedStrings(value) {
  if (typeof value === "string") return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((entry) => nestedStrings(entry));
}

function normalizeTarget(value) {
  return value.replace(/^\.\//u, "");
}

function hasExactStrings(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => typeof value === "string" && value === expected[index])
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonSuffix(output) {
  const candidates = [...output.matchAll(/^(?:\{|\[)/gmu)]
    .map(({ index }) => index ?? -1)
    .reverse();
  for (const index of candidates) {
    try {
      return JSON.parse(output.slice(index));
    } catch {
      continue;
    }
  }
  throw new Error("Public package pack output is invalid");
}

async function calculateUnpackedSize(root, packageContract, files) {
  let total = 0;
  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string") continue;
    const source =
      file.path === "LICENSE" ? join(root, "LICENSE") : join(packageContract.directory, file.path);
    total += (await stat(source)).size;
  }
  return total;
}

async function packedArchive(archiveDirectory, packResult) {
  if (!isRecord(packResult) || typeof packResult.filename !== "string") {
    throw new Error("Public package pack output is invalid");
  }
  const filename = resolve(packResult.filename);
  const archiveRelativePath = relative(archiveDirectory, filename);
  if (archiveRelativePath.startsWith("..") || archiveRelativePath.includes("/")) {
    throw new Error("Public package pack output is invalid");
  }
  return { path: filename, size: (await stat(filename)).size };
}

async function smokeInstallPackedPackages(root, packages, archives) {
  const directory = await mkdtemp(join(tmpdir(), "tenantscript-package-smoke-"));
  try {
    const environment = {
      ...sanitizePackageManagerEnvironment(process.env),
      HOME: directory,
      USERPROFILE: directory
    };
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: "tenantscript-package-smoke", private: true, type: "module" }, null, 2)}\n`
    );
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...archives
      ],
      directory,
      "Packed package smoke install failed",
      environment
    );
    const specifiers = packages.flatMap(({ name, manifest }) =>
      isRecord(manifest.exports)
        ? Object.keys(manifest.exports).map((subpath) =>
            subpath === "." ? name : `${name}${subpath.slice(1)}`
          )
        : []
    );
    await run(
      "node",
      [
        "--input-type=module",
        "--eval",
        `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)))`
      ],
      directory,
      "Packed package import smoke failed",
      environment
    );
    const typeImports = specifiers.map(
      (specifier, index) => `import * as package${String(index)} from ${JSON.stringify(specifier)};`
    );
    await writeFile(
      join(directory, "smoke.mts"),
      `${typeImports.join("\n")}\nvoid [${specifiers.map((_, index) => `package${String(index)}`).join(", ")}];\n`
    );
    await run(
      join(root, "node_modules", ".bin", "tsc"),
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--lib",
        "ES2022,DOM",
        "smoke.mts"
      ],
      directory,
      "Packed package type smoke failed",
      environment
    );
    const cli = await runResult(
      join(directory, "node_modules", ".bin", "ext"),
      [],
      directory,
      environment
    );
    if (cli.code !== 2 || cli.stdout !== "" || cli.stderr !== "unknown command: \n") {
      throw new Error("Packed CLI usage smoke failed");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sanitizePackageManagerEnvironment(environment) {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "LANG",
    "LC_ALL"
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => allowed.has(name.toUpperCase()) && typeof value === "string"
    )
  );
}

function isAllowedPackedPath(path) {
  if (path === "package.json" || path === "LICENSE" || path === "README.md") return true;
  if (!path.startsWith("dist/") || path.includes("..") || path.includes("\\")) return false;
  return /(?:\.d\.ts|\.js)$/u.test(path);
}

function isSensitivePackedPath(path) {
  const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".npmrc" ||
    basename === "credentials.json" ||
    basename === "service-account.json" ||
    /\.(?:key|pem|p12|pfx|sqlite|sqlite3|db)$/u.test(basename)
  );
}

async function run(
  command,
  args,
  cwd,
  failureMessage = "Public package build failed",
  environment = process.env
) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: "inherit" });
    child.once("error", () => reject(new Error(failureMessage)));
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(failureMessage));
    });
  });
}

async function runResult(command, args, cwd, environment = process.env) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", () => reject(new Error("Packed CLI usage smoke failed")));
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function runCapture(command, args, cwd, environment = process.env) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => reject(new Error("Public package pack failed")));
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error("Public package pack failed"));
    });
  });
}

async function main() {
  const [command, action] = process.argv.slice(2);
  if (command === "build" && action === undefined) {
    await buildPublicPackages(defaultRoot);
    return;
  }
  if (command === "check" && action === undefined) {
    const inventory = await packAndValidatePublicPackages(defaultRoot);
    console.log(JSON.stringify({ version: 1, packages: inventory }));
    return;
  }
  throw new Error("Unknown publishable package command");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Publishable package command failed");
    process.exitCode = 1;
  });
}
