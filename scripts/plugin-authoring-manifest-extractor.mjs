import ts from "typescript";

import { evaluatePluginAuthoringManifestJudges } from "./plugin-authoring-manifest-judges.mjs";

export const MANIFEST_SOURCE_MAX_BYTES = 262_144;

const MAX_AST_NODES = 2_048;
const MAX_DATA_DEPTH = 32;
const FORBIDDEN_PROPERTY_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const FAILED = Object.freeze({ ok: false });

export function extractPluginAuthoringManifest(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MANIFEST_SOURCE_MAX_BYTES) {
    return { ...FAILED };
  }

  try {
    const sourceFile = ts.createSourceFile(
      "manifest.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    if (sourceFile.parseDiagnostics.length > 0 || !isBoundedAst(sourceFile)) {
      return { ...FAILED };
    }
    if (sourceFile.statements.length !== 2) return { ...FAILED };

    const [importStatement, manifestStatement] = sourceFile.statements;
    if (!isCanonicalTypeImport(importStatement) || !ts.isVariableStatement(manifestStatement)) {
      return { ...FAILED };
    }

    const declaration = readManifestDeclaration(manifestStatement);
    if (declaration === undefined) return { ...FAILED };

    // Manifest source is untrusted candidate code. Interpreting only a closed data-literal grammar
    // keeps top-level calls, imports, getters, and identifier references from executing in the judge.
    const value = readDataLiteral(declaration.expression, 0);
    return { ok: true, value };
  } catch {
    // TypeScript diagnostics and source fragments may contain candidate secrets. The caller only
    // receives a closed failure signal that maps to the fixed judge failure taxonomy.
    return { ...FAILED };
  }
}

export function evaluatePluginAuthoringManifestSourceJudges({ task, source, parseManifest }) {
  const extracted = extractPluginAuthoringManifest(source);
  if (extracted.ok !== true) return { manifest: false, "least-privilege": false };
  return evaluatePluginAuthoringManifestJudges({ task, manifest: extracted.value, parseManifest });
}

function isCanonicalTypeImport(statement) {
  if (!ts.isImportDeclaration(statement)) return false;
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
  if (statement.moduleSpecifier.text !== "@tenantscript/manifest") return false;
  if (statement.attributes !== undefined || statement.assertClause !== undefined) return false;

  const clause = statement.importClause;
  if (clause === undefined || clause.name !== undefined || clause.isTypeOnly !== true) return false;
  if (!ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.length !== 1) {
    return false;
  }
  const [specifier] = clause.namedBindings.elements;
  return (
    specifier.propertyName === undefined &&
    specifier.name.text === "TenantScriptManifest" &&
    specifier.isTypeOnly === false
  );
}

function readManifestDeclaration(statement) {
  if (!hasExactModifier(statement, ts.SyntaxKind.ExportKeyword)) return undefined;
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
  if (statement.declarationList.declarations.length !== 1) return undefined;

  const [declaration] = statement.declarationList.declarations;
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "manifest") return undefined;
  if (declaration.type !== undefined || declaration.exclamationToken !== undefined)
    return undefined;
  if (declaration.initializer === undefined || !ts.isSatisfiesExpression(declaration.initializer)) {
    return undefined;
  }

  const type = declaration.initializer.type;
  if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  if (type.typeName.text !== "TenantScriptManifest" || type.typeArguments !== undefined) {
    return undefined;
  }
  return declaration.initializer;
}

function hasExactModifier(node, expectedKind) {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.length === 1 && modifiers[0].kind === expectedKind;
}

function readDataLiteral(node, depth) {
  if (depth > MAX_DATA_DEPTH) throw new Error("manifest data is too deep");

  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return readFiniteNumber(node.text, 1);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return readFiniteNumber(node.operand.text, -1);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) => {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        throw new Error("manifest array element is unsupported");
      }
      return readDataLiteral(element, depth + 1);
    });
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = Object.create(null);
    const keys = new Set();
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new Error("manifest object property is unsupported");
      }
      const key = readPropertyName(property.name);
      if (FORBIDDEN_PROPERTY_NAMES.has(key) || keys.has(key)) {
        throw new Error("manifest object key is unsafe");
      }
      keys.add(key);
      value[key] = readDataLiteral(property.initializer, depth + 1);
    }
    return value;
  }

  throw new Error("manifest value is not static data");
}

function readPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error("manifest property name is unsupported");
}

function readFiniteNumber(text, sign) {
  const value = Number(text) * sign;
  if (!Number.isFinite(value)) throw new Error("manifest number is not finite");
  return value;
}

function isBoundedAst(sourceFile) {
  let count = 0;
  const visit = (node) => {
    count += 1;
    if (count > MAX_AST_NODES) throw new Error("manifest AST is too large");
    ts.forEachChild(node, visit);
  };
  try {
    visit(sourceFile);
    return true;
  } catch {
    return false;
  }
}
