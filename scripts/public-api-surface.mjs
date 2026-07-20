import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const snapshotFileName = "api-surface.snapshot.json";

export async function collectPublicApiSurface(rootDirectory) {
  const root = resolve(rootDirectory);
  const packages = await collectPackageEntries(root);
  const entrypoints = packages.flatMap(({ subpaths }) => subpaths.map(({ source }) => source));
  const program = ts.createProgram({
    rootNames: entrypoints,
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
      baseUrl: root,
      paths: {
        "@tenantscript/control-plane/rbac": ["packages/control-plane/src/rbac.ts"],
        "@tenantscript/*": ["packages/*/src/index.ts"]
      }
    }
  });
  const checker = program.getTypeChecker();

  return {
    version: 1,
    packages: packages.map(({ name, subpaths }) => ({
      name,
      subpaths: subpaths.map(({ subpath, source }) => ({
        subpath,
        exports: collectModuleExports(program, checker, source)
      }))
    })),
    controlPlaneRest: await collectRestSurface(root)
  };
}

export async function checkPublicApiSurface(rootDirectory) {
  const root = resolve(rootDirectory);
  let expected;
  try {
    expected = JSON.parse(await readFile(join(root, snapshotFileName), "utf8"));
  } catch {
    throw invalidSnapshot();
  }
  if (!isPublicApiSurface(expected)) throw invalidSnapshot();
  const actual = await collectPublicApiSurface(root);
  const expectedText = serializePublicApiSurface(expected);
  const actualText = serializePublicApiSurface(actual);
  if (expectedText !== actualText) {
    throw new Error(
      `Public API surface drift detected. Review semver and migration impact before running pnpm api-surface:write.\nExpected:\n${expectedText}Actual:\n${actualText}`
    );
  }
}

export function serializePublicApiSurface(surface) {
  return `${JSON.stringify(surface, null, 2)}\n`;
}

async function collectPackageEntries(root) {
  const packagesDirectory = join(root, "packages");
  const directories = await readdir(packagesDirectory, { withFileTypes: true });
  const packages = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const packageDirectory = join(packagesDirectory, directory.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (
      !isRecord(manifest) ||
      manifest.private === true ||
      typeof manifest.name !== "string" ||
      !isRecord(manifest.exports)
    ) {
      continue;
    }
    const subpaths = Object.entries(manifest.exports)
      .map(([subpath, target]) => ({
        subpath,
        source: resolveSourceEntrypoint(packageDirectory, target)
      }))
      .sort((left, right) => left.subpath.localeCompare(right.subpath));
    if (subpaths.length === 0) continue;
    packages.push({ name: manifest.name, subpaths });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function resolveSourceEntrypoint(packageDirectory, target) {
  const typesTarget = isRecord(target) ? target.types : undefined;
  if (
    typeof typesTarget !== "string" ||
    !typesTarget.startsWith("./dist/") ||
    !typesTarget.endsWith(".d.ts")
  ) {
    throw new Error("Public package export map is unsupported");
  }
  const relative = typesTarget.slice("./dist/".length).replace(/\.d\.ts$/u, ".ts");
  if (relative.includes("..")) {
    throw new Error("Public package export map is unsupported");
  }
  return join(packageDirectory, "src", relative);
}

function collectModuleExports(program, checker, entrypoint) {
  const source = program.getSourceFile(entrypoint);
  if (source === undefined || source.symbol === undefined) {
    throw new Error("Public package entrypoint could not be resolved");
  }
  return checker
    .getExportsOfModule(source.symbol)
    .flatMap((symbol) => {
      const resolved =
        (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
      // TypeScript retains an unresolved re-export as an error symbol. It has no declaration and
      // must not preserve a removed API name in the normalized surface.
      if (resolved.declarations === undefined || resolved.declarations.length === 0) return [];
      const isType = (resolved.flags & ts.SymbolFlags.Type) !== 0;
      const isValue = (resolved.flags & ts.SymbolFlags.Value) !== 0;
      return [
        {
          name: symbol.getName(),
          kind: isType && isValue ? "type+value" : isType ? "type" : "value"
        }
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function collectRestSurface(root) {
  const path = join(root, "packages/control-plane/src/http-api.ts");
  const source = ts.createSourceFile(
    path,
    await readFile(path, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  let contracts;
  const visit = (node) => {
    if (
      contracts === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "ADMIN_HTTP_ENDPOINT_CONTRACTS" &&
      node.initializer !== undefined
    ) {
      contracts = unwrapExpression(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (contracts === undefined || !ts.isArrayLiteralExpression(contracts)) {
    throw new Error("Control Plane REST contract could not be resolved");
  }
  return contracts.elements
    .map((element) => parseRestContract(unwrapExpression(element)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parseRestContract(node) {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error("Control Plane REST contract is invalid");
  }
  const properties = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyName(property.name);
    if (name !== undefined) properties.set(name, unwrapExpression(property.initializer));
  }
  const id = stringLiteral(properties.get("id"));
  const path = stringLiteral(properties.get("path"));
  const isolation = stringLiteral(properties.get("isolation"));
  const methodsNode = properties.get("methods");
  if (!ts.isArrayLiteralExpression(methodsNode)) {
    throw new Error("Control Plane REST contract is invalid");
  }
  const methods = methodsNode.elements.map((method) => stringLiteral(unwrapExpression(method)));
  return { id, path, methods: methods.sort(), isolation };
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
}

function stringLiteral(node) {
  if (!ts.isStringLiteral(node)) throw new Error("Control Plane REST contract is invalid");
  return node.text;
}

function isPublicApiSurface(value) {
  if (!hasExactKeys(value, ["version", "packages", "controlPlaneRest"]) || value.version !== 1) {
    return false;
  }
  if (!Array.isArray(value.packages) || !Array.isArray(value.controlPlaneRest)) return false;
  return (
    value.packages.every(
      (entry) =>
        hasExactKeys(entry, ["name", "subpaths"]) &&
        typeof entry.name === "string" &&
        Array.isArray(entry.subpaths) &&
        entry.subpaths.every(
          (subpath) =>
            hasExactKeys(subpath, ["subpath", "exports"]) &&
            typeof subpath.subpath === "string" &&
            Array.isArray(subpath.exports) &&
            subpath.exports.every(
              (symbol) =>
                hasExactKeys(symbol, ["name", "kind"]) &&
                typeof symbol.name === "string" &&
                ["type", "value", "type+value"].includes(symbol.kind)
            )
        )
    ) &&
    value.controlPlaneRest.every(
      (endpoint) =>
        hasExactKeys(endpoint, ["id", "path", "methods", "isolation"]) &&
        typeof endpoint.id === "string" &&
        typeof endpoint.path === "string" &&
        Array.isArray(endpoint.methods) &&
        endpoint.methods.every((method) => typeof method === "string") &&
        typeof endpoint.isolation === "string"
    )
  );
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSnapshot() {
  return new Error("Public API surface snapshot is invalid");
}

async function main() {
  const root = process.cwd();
  if (process.argv.slice(2).includes("--write")) {
    const surface = await collectPublicApiSurface(root);
    await writeFile(join(root, snapshotFileName), serializePublicApiSurface(surface));
    console.log(`Updated ${snapshotFileName}.`);
    return;
  }
  await checkPublicApiSurface(root);
  console.log("Public API surface matches the committed snapshot.");
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Public API surface check failed");
    process.exitCode = 1;
  });
}
