#!/usr/bin/env node

import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";

import ts from "typescript";

const MAX_REQUEST_BYTES = 4 * 1024;
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
      noEmitOnError: true,
      noUncheckedIndexedAccess: true,
      outDir: join(request.buildRoot, "output"),
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
    const emitted = program.emit();
    return !emitted.emitSkipped && emitted.diagnostics.length === 0;
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
  assertExactKeys(request, ["schemaVersion", "taskRoot", "buildRoot"]);
  assert(request.schemaVersion === 1);
  assertAbsoluteNormalizedPath(request.taskRoot);
  assertAbsoluteNormalizedPath(request.buildRoot);
  assert(requestPath === join(request.buildRoot, "request.json"));
  assert(request.taskRoot === join(dirname(request.buildRoot), "source"));
  assertDirectory(request.taskRoot);
  assertDirectory(request.buildRoot);
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
