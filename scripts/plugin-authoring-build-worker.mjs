#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import ts from "typescript";
import { buildSync } from "esbuild";

import {
  PLUGIN_AUTHORING_BUILD_BUNDLE_MAX_BYTES,
  PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION,
  computePluginAuthoringTaskSnapshotDigest
} from "./plugin-authoring-build-contract.mjs";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_DEPTH = 6;
const ALLOWED_PACKAGES = new Set(["@tenantscript/manifest", "@tenantscript/plugin-sdk"]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function executePluginAuthoringBuildWorker(requestPath) {
  try {
    const request = readRequest(requestPath);
    const sourceRoot = join(request.taskRoot, "src");
    assertDirectory(sourceRoot);
    // The worker enumerates a closed source language instead of asking tsc to discover files from
    // candidate package/config metadata. This keeps lifecycle hooks and compiler plugins inert.
    const sourceFiles = collectSourceFiles(sourceRoot);
    assert(sourceFiles.some((path) => path === join(sourceRoot, "index.ts")));
    assert(sourceFiles.some((path) => path === join(sourceRoot, "manifest.ts")));

    const typesRoot = join(request.buildRoot, "types");
    mkdirSync(join(typesRoot, "manifest"), { recursive: true, mode: 0o700 });
    mkdirSync(join(typesRoot, "plugin-sdk"), { recursive: true, mode: 0o700 });
    writeFileSync(join(typesRoot, "manifest", "index.d.ts"), manifestContract(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeFileSync(join(typesRoot, "plugin-sdk", "index.d.ts"), pluginSdkContract(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });

    const options = {
      allowJs: false,
      baseUrl: request.buildRoot,
      declaration: false,
      exactOptionalPropertyTypes: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      lib: ["lib.es2022.d.ts"],
      // Bundler resolution keeps candidate package metadata out of the compiler contract. The
      // judge validates imports itself and never consults candidate `type`, exports, or scripts.
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noEmitOnError: true,
      noUncheckedIndexedAccess: true,
      paths: {
        "@tenantscript/manifest": [join(typesRoot, "manifest", "index.d.ts")],
        "@tenantscript/plugin-sdk": [join(typesRoot, "plugin-sdk", "index.d.ts")]
      },
      rootDir: sourceRoot,
      skipLibCheck: false,
      sourceMap: false,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
      verbatimModuleSyntax: true
    };
    const program = ts.createProgram(sourceFiles, options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length !== 0) return false;

    const runtimeRoot = join(request.buildRoot, "runtime");
    const sdkRoot = join(runtimeRoot, "plugin-sdk");
    const manifestRoot = join(runtimeRoot, "manifest");
    const stateRoot = join(runtimeRoot, "plugin-state");
    const binderRoot = join(runtimeRoot, "reviewed-plugin-binder");
    mkdirSync(sdkRoot, { recursive: true, mode: 0o700 });
    mkdirSync(manifestRoot, { recursive: true, mode: 0o700 });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    mkdirSync(binderRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, "index.js"), pluginStateRuntime(), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeFileSync(join(sdkRoot, "index.js"), pluginSdkRuntime(stateRoot), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeFileSync(join(binderRoot, "index.js"), reviewedPluginBinderRuntime(stateRoot), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    writeFileSync(join(manifestRoot, "index.js"), "export {};\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const wrapperPath = join(request.buildRoot, "entrypoint.js");
    writeFileSync(wrapperPath, reviewedEntrypoint(request.taskRoot, request.reviewedManifest), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    const result = buildSync({
      absWorkingDir: request.taskRoot,
      alias: {
        "@tenantscript/manifest": join(manifestRoot, "index.js"),
        "@tenantscript/plugin-sdk": join(sdkRoot, "index.js")
      },
      bundle: true,
      entryPoints: [wrapperPath],
      format: "cjs",
      ignoreAnnotations: true,
      legalComments: "none",
      logLevel: "silent",
      metafile: true,
      platform: "neutral",
      sourcemap: false,
      target: "es2022",
      treeShaking: false,
      write: false
    });
    const output = result.outputFiles?.[0]?.contents;
    assert(Buffer.isBuffer(output) || output instanceof Uint8Array);
    const bundle = Buffer.from(output);
    assert(bundle.length >= 1 && bundle.length <= PLUGIN_AUTHORING_BUILD_BUNDLE_MAX_BYTES);
    assertBundleInputs(result.metafile, request.taskRoot, sourceRoot, runtimeRoot, wrapperPath);
    const bundlePath = join(request.buildRoot, "bundle.cjs");
    writeFileSync(bundlePath, bundle, { flag: "wx", mode: 0o600 });
    const receipt = {
      schemaVersion: 1,
      contractVersion: PLUGIN_AUTHORING_BUILD_CONTRACT_VERSION,
      taskId: request.taskId,
      sourceSha256: computePluginAuthoringTaskSnapshotDigest(request.taskRoot),
      bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      bundleBytes: bundle.length
    };
    writeFileSync(join(request.buildRoot, "receipt.json"), `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    return true;
  } catch {
    return false;
  }
}

function readRequest(requestPath) {
  assert(typeof requestPath === "string" && isAbsolute(requestPath));
  const metadata = lstatSync(requestPath);
  assert(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
  assert(metadata.size <= MAX_REQUEST_BYTES);
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  assert(isPlainRecord(request));
  assertExactKeys(request, [
    "schemaVersion",
    "taskId",
    "taskRoot",
    "buildRoot",
    "reviewedManifest"
  ]);
  assert(request.schemaVersion === 1);
  assert(typeof request.taskId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.taskId));
  assertAbsoluteNormalizedPath(request.taskRoot);
  assertAbsoluteNormalizedPath(request.buildRoot);
  assert(requestPath === join(request.buildRoot, "request.json"));
  assert(request.taskRoot === join(dirname(request.buildRoot), "source"));
  assert(request.taskId === basename(dirname(request.buildRoot)));
  assertDirectory(request.taskRoot);
  assertDirectory(request.buildRoot);
  validateJsonValue(request.reviewedManifest);
  return request;
}

function collectSourceFiles(sourceRoot) {
  const files = [];
  let totalBytes = 0;
  const visit = (directory, depth) => {
    assert(depth <= MAX_SOURCE_DEPTH);
    for (const entry of readdirSync(directory).sort(compareText)) {
      assert(!entry.startsWith("."));
      const path = join(directory, entry);
      const metadata = lstatSync(path);
      assert(!metadata.isSymbolicLink());
      if (metadata.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      assert(metadata.isFile() && metadata.nlink === 1 && extname(entry) === ".ts");
      assert(!entry.endsWith(".d.ts"));
      totalBytes += metadata.size;
      assert(totalBytes <= MAX_SOURCE_BYTES);
      files.push(path);
      assert(files.length <= MAX_SOURCE_FILES);
      const bytes = readFileSync(path);
      assert(bytes.length === metadata.size);
      const source = textDecoder.decode(bytes);
      validateSource(path, source, sourceRoot);
    }
  };
  visit(sourceRoot, 0);
  assert(files.length >= 2);
  return files;
}

function validateSource(path, source, sourceRoot) {
  assert(!/@ts-(?:ignore|nocheck|expect-error)\b/u.test(source));
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  assert(sourceFile.parseDiagnostics.length === 0);
  // Every candidate source must be a module. Script files and ambient declarations can merge
  // global or trusted package types without importing executable code, weakening the fixed SDK
  // contract even when `.d.ts` files themselves are rejected.
  assert(ts.isExternalModule(sourceFile));
  assert(sourceFile.referencedFiles.length === 0);
  assert(sourceFile.typeReferenceDirectives.length === 0);
  assert(sourceFile.libReferenceDirectives.length === 0);
  const visit = (node) => {
    assert(!ts.isModuleDeclaration(node));
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    assert(!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword));
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert(ts.isStringLiteral(node.moduleSpecifier));
      validateModuleSpecifier(node.moduleSpecifier.text, path, sourceRoot);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      assert(ts.isExternalModuleReference(node.moduleReference));
      assert(ts.isStringLiteral(node.moduleReference.expression));
      validateModuleSpecifier(node.moduleReference.expression.text, path, sourceRoot);
    }
    if (ts.isImportTypeNode(node)) {
      assert(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal));
      validateModuleSpecifier(node.argument.literal.text, path, sourceRoot);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]));
        validateModuleSpecifier(node.arguments[0].text, path, sourceRoot);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") assert(false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function validateModuleSpecifier(specifier, importerPath, sourceRoot) {
  assert(typeof specifier === "string" && specifier.length >= 1 && specifier.length <= 160);
  if (!specifier.startsWith(".")) {
    assert(ALLOWED_PACKAGES.has(specifier));
    return;
  }
  const target = resolve(dirname(importerPath), specifier);
  const relativeTarget = relative(sourceRoot, target);
  assert(
    relativeTarget !== "" &&
      !isAbsolute(relativeTarget) &&
      relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${sep}`)
  );
}

function manifestContract() {
  // Manifest shape and least privilege are already enforced by the non-executing canonical
  // manifest judges. This declaration only supplies the public authoring name for compile-checks,
  // avoiding a second hand-maintained policy implementation in the build worker.
  return `export interface TenantScriptManifest {
  name?: string;
  version?: string;
  hooks?: readonly unknown[];
  capabilities?: Readonly<Record<string, unknown>>;
  configSchema?: unknown;
  egress?: unknown;
  limits?: unknown;
}
`;
}

function pluginSdkContract() {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";
export interface PluginContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}
export type PluginHandler = (payload: unknown, context: PluginContext) => unknown;
export interface DefinePluginInput {
  manifest: TenantScriptManifest;
  handlers: Record<string, PluginHandler>;
}
export declare function definePlugin(input: DefinePluginInput): unknown;
`;
}

function pluginStateRuntime() {
  // Capture the built-ins before candidate modules execute. The exported functions close over the
  // original accessors, so prototype poisoning during candidate initialization cannot replace a
  // reviewed binding lookup with candidate-controlled executable code.
  return `const definitions = new WeakMap();
const safeGet = Function.prototype.call.bind(WeakMap.prototype.get);
const safeSet = Function.prototype.call.bind(WeakMap.prototype.set);
export function registerPluginDefinition(plugin, bind) {
  safeSet(definitions, plugin, bind);
}
export function readPluginDefinition(plugin) {
  return safeGet(definitions, plugin);
}
`;
}

function pluginSdkRuntime(stateRoot) {
  // Keep this runtime deliberately smaller than the public SDK surface: candidate code can only
  // receive the reviewed definePlugin dispatch behavior needed by the fixed authoring corpus.
  return `import { registerPluginDefinition } from ${JSON.stringify(join(stateRoot, "index.js"))};
export function definePlugin(input) {
  const plugin = {
    manifest: input.manifest,
    dispatch: (request) => dispatchPlugin(input, request)
  };
  registerPluginDefinition(plugin, (reviewedManifest) => {
    const reviewedDefinition = { manifest: reviewedManifest, handlers: input.handlers };
    return {
      manifest: reviewedManifest,
      dispatch: (request) => dispatchPlugin(reviewedDefinition, request)
    };
  });
  return plugin;
}
async function dispatchPlugin(input, request) {
  const hook = input.manifest.hooks.find((candidate) => candidate.name === request.hookName);
  if (hook === undefined) return { ok: false, error: { name: "UnknownHookError", hookName: request.hookName } };
  const handler = input.handlers[request.hookName];
  if (handler === undefined) return { ok: false, error: { name: "MissingHandlerError", hookName: request.hookName } };
  let value;
  try { value = await handler(request.payload, request.context); }
  catch (error) {
    return { ok: false, error: { name: "PluginHandlerError", hookName: request.hookName, message: error instanceof Error ? error.message : "Unknown plugin handler failure" } };
  }
  if (hook.type === "event") return { ok: true, value: undefined };
  if (hook.type === "transform") {
    return value === undefined
      ? { ok: false, error: { name: "HookReturnContractError", hookName: request.hookName, message: "transform hooks must return a payload" } }
      : { ok: true, value };
  }
  const valid = value !== null && typeof value === "object" && "decision" in value &&
    (value.decision === "allow" || value.decision === "deny" || (value.decision === "modify" && "payload" in value));
  return valid
    ? { ok: true, value }
    : { ok: false, error: { name: "HookReturnContractError", hookName: request.hookName, message: "policy hooks must return allow, deny, or modify with a payload" } };
}
`;
}

function reviewedPluginBinderRuntime(stateRoot) {
  // This module is imported only by the generated wrapper. Candidate source cannot name its path:
  // candidate imports are restricted to the public SDK root and relatives inside the source tree.
  return `import { readPluginDefinition } from ${JSON.stringify(join(stateRoot, "index.js"))};
export function bindReviewedPlugin(plugin, reviewedManifest) {
  const bind = readPluginDefinition(plugin);
  if (bind === undefined) throw new Error("plugin must be created by definePlugin");
  return bind(reviewedManifest);
}
`;
}

function reviewedEntrypoint(taskRoot, reviewedManifest) {
  return `import * as candidate from ${JSON.stringify(join(taskRoot, "src", "index.ts"))};
import { bindReviewedPlugin } from ${JSON.stringify(join(dirname(taskRoot), "build", "runtime", "reviewed-plugin-binder", "index.js"))};
const candidatePlugin = candidate.plugin ?? candidate.default;
export const plugin = bindReviewedPlugin(candidatePlugin, ${JSON.stringify(reviewedManifest)});
export default plugin;
`;
}

function assertBundleInputs(metafile, workingRoot, sourceRoot, runtimeRoot, wrapperPath) {
  assert(isPlainRecord(metafile) && isPlainRecord(metafile.inputs));
  for (const input of Object.keys(metafile.inputs)) {
    const absolute = resolve(workingRoot, input);
    assert(
      absolute === wrapperPath || isWithin(absolute, sourceRoot) || isWithin(absolute, runtimeRoot)
    );
  }
}

function validateJsonValue(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1;
  assert(state.nodes <= 4_096 && depth <= 32);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    assert(Number.isFinite(value));
    return;
  }
  if (Array.isArray(value)) {
    assert(value.length <= 512);
    for (const entry of value) validateJsonValue(entry, depth + 1, state);
    return;
  }
  assert(isPlainRecord(value) && Object.keys(value).length <= 512);
  for (const nested of Object.values(value)) validateJsonValue(nested, depth + 1, state);
}

function isWithin(path, root) {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

function assertAbsoluteNormalizedPath(path) {
  assert(typeof path === "string" && isAbsolute(path) && resolve(path) === path);
}

function assertDirectory(path) {
  const metadata = lstatSync(path);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink());
}

function assertExactKeys(value, keys) {
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const success =
    process.argv.length === 3 && executePluginAuthoringBuildWorker(resolve(process.argv[2]));
  if (success) process.stdout.write('{"ok":true}\n');
  process.exitCode = success ? 0 : 1;
}
