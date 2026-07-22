import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION = 1;
export const PLUGIN_AUTHORING_BUILD_BUNDLE_MAX_BYTES = 1024 * 1024;

const MAX_RECEIPT_BYTES = 4 * 1024;
const MAX_SNAPSHOT_FILES = 2_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_DEPTH = 8;

export function computePluginAuthoringTaskSnapshotDigest(taskRoot) {
  try {
    assertAbsoluteDirectory(taskRoot);
    const records = [];
    let totalBytes = 0;
    const visit = (directory, depth) => {
      assert(depth <= MAX_SNAPSHOT_DEPTH);
      for (const entry of readdirSync(directory).sort(compareText)) {
        assert(!entry.startsWith("."));
        const path = join(directory, entry);
        const metadata = lstatSync(path);
        assert(!metadata.isSymbolicLink());
        if (metadata.isDirectory()) {
          visit(path, depth + 1);
          continue;
        }
        assert(metadata.isFile() && metadata.nlink === 1);
        const relativePath = relative(taskRoot, path).split(sep).join("/");
        assert(relativePath.length >= 1 && Buffer.byteLength(relativePath) <= 240);
        const bytes = readFileSync(path);
        assert(bytes.length === metadata.size && bytes.length <= 256 * 1024);
        totalBytes += bytes.length;
        assert(totalBytes <= MAX_SNAPSHOT_BYTES);
        records.push({ path: relativePath, bytes });
        assert(records.length <= MAX_SNAPSHOT_FILES);
      }
    };
    visit(taskRoot, 0);
    assert(records.length >= 1);

    // Length-prefix both names and bytes so no candidate-controlled concatenation can produce the
    // same digest through path/content boundary ambiguity.
    const digest = createHash("sha256");
    for (const record of records) {
      const pathBytes = Buffer.from(record.path, "utf8");
      const header = Buffer.alloc(12);
      header.writeUInt32BE(pathBytes.length, 0);
      header.writeBigUInt64BE(BigInt(record.bytes.length), 4);
      digest.update(header).update(pathBytes).update(record.bytes);
    }
    return digest.digest("hex");
  } catch {
    throw new Error("plugin authoring task snapshot is invalid");
  }
}

export function verifyPluginAuthoringBuildReceipt(context) {
  try {
    assert(isPlainRecord(context));
    assert(isPlainRecord(context.task));
    assert(
      typeof context.task.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(context.task.id)
    );
    assertAbsoluteDirectory(context.taskRoot);
    assertAbsoluteDirectory(context.taskWorkspace);
    assert(context.taskRoot === join(context.taskWorkspace, "source"));
    const buildRoot = join(context.taskWorkspace, "build");
    assertAbsoluteDirectory(buildRoot);
    const receiptPath = join(buildRoot, "receipt.json");
    const receipt = readBoundedRegularJson(receiptPath, MAX_RECEIPT_BYTES);
    assertExactKeys(receipt, [
      "schemaVersion",
      "contractVersion",
      "taskId",
      "sourceSha256",
      "bundleSha256",
      "bundleBytes"
    ]);
    assert(receipt.schemaVersion === 1);
    assert(receipt.contractVersion === PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION);
    assert(receipt.taskId === context.task.id);
    assert(/^[0-9a-f]{64}$/u.test(receipt.sourceSha256));
    assert(/^[0-9a-f]{64}$/u.test(receipt.bundleSha256));
    assert(
      Number.isSafeInteger(receipt.bundleBytes) &&
        receipt.bundleBytes >= 1 &&
        receipt.bundleBytes <= PLUGIN_AUTHORING_BUILD_BUNDLE_MAX_BYTES
    );
    assert(receipt.sourceSha256 === computePluginAuthoringTaskSnapshotDigest(context.taskRoot));

    const bundlePath = join(buildRoot, "bundle.cjs");
    const metadata = lstatSync(bundlePath);
    assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
    assert(metadata.size === receipt.bundleBytes);
    const bundle = readFileSync(bundlePath);
    assert(bundle.length === receipt.bundleBytes);
    assert(createHash("sha256").update(bundle).digest("hex") === receipt.bundleSha256);
    return Object.freeze({ ...receipt, bundlePath });
  } catch {
    throw new Error("plugin authoring build receipt is invalid");
  }
}

function readBoundedRegularJson(path, maximumBytes) {
  const metadata = lstatSync(path);
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.nlink === 1 &&
      metadata.size <= maximumBytes
  );
  const bytes = readFileSync(path);
  assert(bytes.length === metadata.size && bytes.length <= maximumBytes);
  return JSON.parse(bytes.toString("utf8"));
}

function assertAbsoluteDirectory(path) {
  assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}

function assertExactKeys(value, keys) {
  assert(isPlainRecord(value));
  assert(
    Object.keys(value).sort(compareText).join("\0") === [...keys].sort(compareText).join("\0")
  );
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assert(condition) {
  if (!condition) throw new Error("assertion failed");
}
