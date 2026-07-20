import { gzipSync } from "node:zlib";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, join, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_CONFIG_BYTES = 4_096;
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_ASSET_BYTES = 20 * 1_048_576;
const MAX_FILES = 512;
const MAX_PATH_LENGTH = 240;
const allowedOutputExtensions = new Set([
  ".avif",
  ".css",
  ".gif",
  ".html",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2"
]);

export async function evaluateAdminUiBundleBudget(distDirectory, budgetPath) {
  const distRoot = resolve(distDirectory);
  await assertDirectory(distRoot);
  const budget = parseBudget(await readBoundedFile(budgetPath, MAX_CONFIG_BYTES, "budget"));
  const manifest = parseManifest(
    await readBoundedFile(join(distRoot, ".vite", "manifest.json"), MAX_MANIFEST_BYTES, "manifest")
  );
  const outputFiles = await collectOutputFiles(distRoot);
  const initialAssets = collectInitialAssets(manifest);
  initialAssets.add("index.html");

  for (const asset of initialAssets) {
    if (!outputFiles.has(asset)) {
      throw new Error("Admin UI bundle output is invalid: manifest asset is missing");
    }
  }

  const javaScriptAndCssAssets = [...outputFiles].filter((path) =>
    [".js", ".css"].includes(extname(path))
  );
  const initialPageGzipBytes = await sumGzipBytes(distRoot, [...initialAssets]);
  const totalJavaScriptAndCssGzipBytes = await sumGzipBytes(distRoot, javaScriptAndCssAssets);

  if (initialPageGzipBytes > budget.maxInitialPageGzipBytes) {
    throw new Error(
      `Admin UI bundle budget exceeded: initial page gzip ${String(initialPageGzipBytes)} > ${String(budget.maxInitialPageGzipBytes)} bytes`
    );
  }
  if (totalJavaScriptAndCssGzipBytes > budget.maxTotalJavaScriptAndCssGzipBytes) {
    throw new Error(
      `Admin UI bundle budget exceeded: total JavaScript/CSS gzip ${String(totalJavaScriptAndCssGzipBytes)} > ${String(budget.maxTotalJavaScriptAndCssGzipBytes)} bytes`
    );
  }

  return {
    version: 1,
    initialPageGzipBytes,
    maxInitialPageGzipBytes: budget.maxInitialPageGzipBytes,
    totalJavaScriptAndCssGzipBytes,
    maxTotalJavaScriptAndCssGzipBytes: budget.maxTotalJavaScriptAndCssGzipBytes,
    initialAssets: [...initialAssets].sort(),
    javaScriptAndCssAssets: javaScriptAndCssAssets.sort()
  };
}

function parseBudget(contents) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Admin UI bundle budget is invalid");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "maxInitialPageGzipBytes",
      "maxTotalJavaScriptAndCssGzipBytes",
      "version"
    ])
  ) {
    throw new Error("Admin UI bundle budget is invalid");
  }
  if (
    value.version !== 1 ||
    !isPositiveSafeInteger(value.maxInitialPageGzipBytes) ||
    !isPositiveSafeInteger(value.maxTotalJavaScriptAndCssGzipBytes) ||
    value.maxInitialPageGzipBytes > 10 * 1_048_576 ||
    value.maxTotalJavaScriptAndCssGzipBytes > 10 * 1_048_576
  ) {
    throw new Error("Admin UI bundle budget is invalid");
  }
  return value;
}

function parseManifest(contents) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Admin UI bundle manifest is invalid");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).length > MAX_FILES
  ) {
    throw new Error("Admin UI bundle manifest is invalid");
  }

  const records = new Map();
  const emittedFiles = new Set();
  for (const [key, candidate] of Object.entries(value)) {
    if (!isManifestKey(key) || !isRecord(candidate) || !isSafeAssetPath(candidate.file)) {
      throw new Error("Admin UI bundle manifest is invalid: unsafe asset path");
    }
    const extension = extname(candidate.file);
    if (!allowedOutputExtensions.has(extension)) {
      throw new Error("Admin UI bundle manifest is invalid: unsupported asset type");
    }
    // Vite may expose CSS, fonts, and images as top-level manifest records. They are
    // measured from the output tree or a chunk's asset lists, but only JS records form
    // the synchronous import graph that determines the initial page.
    if (extension !== ".js") {
      continue;
    }
    if (emittedFiles.has(candidate.file)) {
      throw new Error("Admin UI bundle manifest is invalid: duplicate emitted file");
    }
    emittedFiles.add(candidate.file);
    records.set(key, {
      file: candidate.file,
      isEntry: candidate.isEntry === true,
      imports: parseStringArray(candidate.imports, isManifestKey, "manifest reference"),
      css: parseStringArray(candidate.css, isCssAssetPath, "CSS asset path"),
      assets: parseStringArray(candidate.assets, isSafeAssetPath, "asset path")
    });
  }

  const entries = [...records.entries()].filter(([, record]) => record.isEntry);
  if (entries.length !== 1 || entries[0][0] !== "index.html") {
    throw new Error("Admin UI bundle manifest is invalid: expected exactly one entry");
  }
  return { records, entryKey: entries[0][0] };
}

function collectInitialAssets(manifest) {
  const assets = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    visited.add(key);
    const record = manifest.records.get(key);
    if (record === undefined) {
      throw new Error("Admin UI bundle manifest is invalid: missing import record");
    }
    assets.add(record.file);
    for (const path of record.css) assets.add(path);
    for (const path of record.assets) assets.add(path);
    for (const importedKey of record.imports) visit(importedKey);
  };
  visit(manifest.entryKey);
  return assets;
}

async function collectOutputFiles(distRoot) {
  const files = new Set();
  const visit = async (relativeDirectory) => {
    const directory = join(distRoot, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error("Admin UI bundle output is invalid: symbolic links are forbidden");
      }
      const relativePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (!isSafeAssetPath(relativePath)) {
        throw new Error("Admin UI bundle output is invalid: unsafe output path");
      }
      if (entry.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (
        !entry.isFile() ||
        extname(relativePath) === ".map" ||
        !allowedOutputExtensions.has(extname(relativePath))
      ) {
        throw new Error("Admin UI bundle output is invalid: unsupported output file");
      }
      files.add(relativePath);
      if (files.size > MAX_FILES) {
        throw new Error("Admin UI bundle output is invalid: too many files");
      }
    }
  };
  await visit("");
  return files;
}

async function sumGzipBytes(distRoot, assets) {
  let total = 0;
  for (const asset of [...new Set(assets)].sort()) {
    const contents = await readAsset(distRoot, asset);
    total += gzipSync(contents, { level: 9 }).byteLength;
  }
  return total;
}

async function readAsset(distRoot, relativePath) {
  if (!isSafeAssetPath(relativePath)) {
    throw new Error("Admin UI bundle output is invalid: unsafe asset path");
  }
  const path = resolve(distRoot, relativePath);
  if (!path.startsWith(`${distRoot}${sep}`)) {
    throw new Error("Admin UI bundle output is invalid: unsafe asset path");
  }
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) {
    throw new Error("Admin UI bundle output is invalid: manifest asset is missing");
  }
  if (metadata.isSymbolicLink()) {
    throw new Error("Admin UI bundle output is invalid: symbolic links are forbidden");
  }
  if (metadata.size > MAX_ASSET_BYTES) {
    throw new Error("Admin UI bundle output is invalid: asset is too large");
  }
  return await readFile(path);
}

async function readBoundedFile(path, maxBytes, label) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maxBytes
  ) {
    throw new Error(`Admin UI bundle ${label} is invalid`);
  }
  return await readFile(path, "utf8");
}

async function assertDirectory(path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (metadata === undefined || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Admin UI bundle output is invalid");
  }
}

function parseStringArray(value, predicate, label) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_FILES ||
    new Set(value).size !== value.length ||
    value.some((item) => typeof item !== "string" || !predicate(item))
  ) {
    throw new Error(`Admin UI bundle manifest is invalid: unsafe ${label}`);
  }
  return value;
}

function isSafeAssetPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    posix.normalize(value) === value &&
    value.split("/").every((segment) => segment !== "." && segment !== ".." && segment !== "")
  );
}

function isCssAssetPath(value) {
  return isSafeAssetPath(value) && extname(value) === ".css";
}

function isManifestKey(value) {
  return isSafeAssetPath(value) && !value.startsWith(".vite/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort());
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

async function runCli() {
  if (process.argv.length !== 4) {
    throw new Error("usage: admin-ui-bundle-budget <dist-directory> <budget-file>");
  }
  const report = await evaluateAdminUiBundleBudget(process.argv[2], process.argv[3]);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Admin UI bundle budget check failed"}\n`
    );
    process.exitCode = 1;
  });
}
