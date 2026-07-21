import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const controlPlanePackage = "@tenantscript/control-plane";
const publicPackages = new Set([
  "@tenantscript/capabilities",
  "@tenantscript/cli",
  controlPlanePackage,
  "@tenantscript/host-sdk",
  "@tenantscript/loader",
  "@tenantscript/manifest",
  "@tenantscript/plugin-sdk",
  "@tenantscript/proxy"
]);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function validateBreakingReleasePolicy({
  baseSurface,
  currentSurface,
  changesets,
  repositoryFiles
}) {
  const breakingChanges = collectBreakingChanges(baseSurface, currentSurface);
  if (breakingChanges.size === 0) return;

  const parsedChangesets = changesets.map(parseChangeset);
  const errors = [];
  for (const [packageName, reasons] of breakingChanges) {
    const candidates = parsedChangesets.filter(
      ({ releases }) => releases.get(packageName) === "major"
    );
    if (candidates.length === 0) {
      errors.push(
        `${packageName}: ${reasons.join("; ")}; a major Changeset is required for the affected package`
      );
      continue;
    }
    if (!candidates.some((changeset) => hasMigrationGuide(changeset, repositoryFiles))) {
      errors.push(
        `${packageName}: the major Changeset must link an existing migration guide under docs/migrations`
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Breaking public API release policy failed:\n${errors.map((error) => `- ${error}`).join("\n")}`
    );
  }
}

export function collectBreakingChanges(baseSurface, currentSurface) {
  const changes = new Map();
  const currentPackages = new Map(currentSurface.packages.map((entry) => [entry.name, entry]));
  for (const basePackage of baseSurface.packages) {
    const currentPackage = currentPackages.get(basePackage.name);
    if (currentPackage === undefined) {
      addChange(changes, basePackage.name, "removed package surface");
      continue;
    }
    const currentSubpaths = new Map(currentPackage.subpaths.map((entry) => [entry.subpath, entry]));
    for (const baseSubpath of basePackage.subpaths) {
      const currentSubpath = currentSubpaths.get(baseSubpath.subpath);
      if (currentSubpath === undefined) {
        addChange(changes, basePackage.name, `removed subpath ${baseSubpath.subpath}`);
        continue;
      }
      const currentExports = new Map(
        currentSubpath.exports.map((entry) => [entry.name, entry.kind])
      );
      for (const exported of baseSubpath.exports) {
        const currentKind = currentExports.get(exported.name);
        if (currentKind === undefined) {
          addChange(changes, basePackage.name, `removed export ${exported.name}`);
        } else if (currentKind !== exported.kind) {
          addChange(
            changes,
            basePackage.name,
            `changed export ${exported.name} from ${exported.kind} to ${currentKind}`
          );
        }
      }
    }
  }

  const currentEndpoints = new Map(
    currentSurface.controlPlaneRest.map((entry) => [entry.id, entry])
  );
  for (const baseEndpoint of baseSurface.controlPlaneRest) {
    const currentEndpoint = currentEndpoints.get(baseEndpoint.id);
    if (currentEndpoint === undefined) {
      addChange(changes, controlPlanePackage, `removed REST endpoint ${baseEndpoint.id}`);
      continue;
    }
    if (
      currentEndpoint.path !== baseEndpoint.path ||
      currentEndpoint.isolation !== baseEndpoint.isolation
    ) {
      addChange(changes, controlPlanePackage, `changed REST contract ${baseEndpoint.id}`);
    }
    const currentMethods = new Set(currentEndpoint.methods);
    const removedMethods = baseEndpoint.methods.filter((method) => !currentMethods.has(method));
    if (removedMethods.length > 0) {
      addChange(
        changes,
        controlPlanePackage,
        `removed REST methods ${removedMethods.join(",")} from ${baseEndpoint.id}`
      );
    }
    if (Array.isArray(baseEndpoint.success)) {
      const currentSuccess = new Map(
        (Array.isArray(currentEndpoint.success) ? currentEndpoint.success : []).map((entry) => [
          entry.method,
          entry
        ])
      );
      for (const baseSuccess of baseEndpoint.success) {
        const current = currentSuccess.get(baseSuccess.method);
        if (current === undefined || JSON.stringify(current) !== JSON.stringify(baseSuccess)) {
          addChange(
            changes,
            controlPlanePackage,
            `changed REST success response ${baseEndpoint.id} ${baseSuccess.method}`
          );
        }
      }
    }
  }

  const currentCallbacks = new Map(
    (Array.isArray(currentSurface.controlPlaneCallbacks)
      ? currentSurface.controlPlaneCallbacks
      : []
    ).map((entry) => [entry.id, entry])
  );
  for (const baseCallback of Array.isArray(baseSurface.controlPlaneCallbacks)
    ? baseSurface.controlPlaneCallbacks
    : []) {
    const currentCallback = currentCallbacks.get(baseCallback.id);
    if (currentCallback === undefined) {
      addChange(changes, controlPlanePackage, `removed callback ${baseCallback.id}`);
      continue;
    }
    if (
      currentCallback.path !== baseCallback.path ||
      currentCallback.isolation !== baseCallback.isolation
    ) {
      addChange(changes, controlPlanePackage, `changed callback contract ${baseCallback.id}`);
    }
    const currentMethods = new Set(currentCallback.methods);
    const removedMethods = baseCallback.methods.filter((method) => !currentMethods.has(method));
    if (removedMethods.length > 0) {
      addChange(
        changes,
        controlPlanePackage,
        `removed callback methods ${removedMethods.join(",")} from ${baseCallback.id}`
      );
    }
  }

  if (isRecord(baseSurface.controlPlaneSuccessResponses)) {
    const currentSchemas = isRecord(currentSurface.controlPlaneSuccessResponses)
      ? currentSurface.controlPlaneSuccessResponses
      : {};
    for (const [schemaId, baseSchema] of Object.entries(baseSurface.controlPlaneSuccessResponses)) {
      if (JSON.stringify(currentSchemas[schemaId]) !== JSON.stringify(baseSchema)) {
        addChange(changes, controlPlanePackage, `changed REST success schema ${schemaId}`);
      }
    }
  }
  return changes;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChangeset({ path, content }) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) throw new Error(`${path}: malformed Changeset frontmatter`);
  const releases = new Map();
  for (const line of match[1].split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const release = /^"([^"]+)":\s*(major|minor|patch)$/u.exec(line.trim());
    if (release === null) throw new Error(`${path}: malformed Changeset release entry`);
    if (!publicPackages.has(release[1])) {
      throw new Error(`${path}: unknown public package ${release[1]}`);
    }
    if (releases.has(release[1])) {
      throw new Error(`${path}: duplicate release entry ${release[1]}`);
    }
    releases.set(release[1], release[2]);
  }
  return { path, body: match[2], releases };
}

function hasMigrationGuide(changeset, repositoryFiles) {
  const links = [...changeset.body.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]);
  return links.some((target) => {
    if (/^[a-z]+:/iu.test(target) || target.startsWith("/") || target.includes("#")) return false;
    // Resolve from the Changeset location so the documented link is also valid on GitHub.
    const normalized = posix.normalize(posix.join(posix.dirname(changeset.path), target));
    return normalized.startsWith("docs/migrations/") && repositoryFiles.has(normalized);
  });
}

function addChange(changes, packageName, reason) {
  const reasons = changes.get(packageName) ?? [];
  reasons.push(reason);
  changes.set(packageName, reasons);
}

export async function checkBreakingReleasePolicy(rootDirectory, baseRef = "origin/main") {
  if (!/^[A-Za-z0-9._/-]+$/u.test(baseRef)) throw new Error("Release policy base ref is invalid");
  const root = resolve(rootDirectory);
  const [baseText, currentText, changesets, repositoryFiles] = await Promise.all([
    runCapture("git", ["show", `${baseRef}:api-surface.snapshot.json`], root),
    readFile(join(root, "api-surface.snapshot.json"), "utf8"),
    readChangesets(root),
    collectMigrationGuides(root)
  ]);
  validateBreakingReleasePolicy({
    baseSurface: parseSurface(baseText, "base"),
    currentSurface: parseSurface(currentText, "current"),
    changesets,
    repositoryFiles
  });
}

async function readChangesets(root) {
  const directory = join(root, ".changeset");
  const entries = await readdir(directory, { withFileTypes: true });
  return await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => ({
        path: `.changeset/${entry.name}`,
        content: await readFile(join(directory, entry.name), "utf8")
      }))
  );
}

async function collectMigrationGuides(root) {
  const directory = join(root, "docs", "migrations");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return new Set();
  }
  return new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
      .map((entry) => `docs/migrations/${entry.name}`)
  );
}

function parseSurface(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Release policy ${label} API snapshot is invalid`);
  }
}

async function runCapture(command, args, cwd) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => reject(new Error("Release policy base snapshot is unavailable")));
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error("Release policy base snapshot is unavailable"));
    });
  });
}

async function main() {
  const baseBranch = process.env.GITHUB_BASE_REF;
  const baseRef =
    baseBranch === undefined || baseBranch === "" ? "origin/main" : `origin/${baseBranch}`;
  await checkBreakingReleasePolicy(defaultRoot, baseRef);
  console.log(`Breaking public API release policy passed against ${baseRef}.`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Breaking release policy failed");
    process.exitCode = 1;
  });
}
