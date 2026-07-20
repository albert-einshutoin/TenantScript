import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface PluginScaffoldRequest {
  name: string;
  directory: string;
  hookName: string;
  hookType: "event" | "transform" | "policy";
}

export interface PluginScaffoldResult {
  name: string;
  directory: string;
  files: readonly string[];
}

const exactPackageVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function writePluginScaffold(
  request: PluginScaffoldRequest
): Promise<PluginScaffoldResult> {
  // Resolve trusted package metadata before creating directories so a damaged installation cannot
  // leave a partial scaffold or silently point a new plugin at a different SDK release.
  const cliVersion = await readCliPackageVersion();
  const files = [
    "package.json",
    "tsconfig.json",
    "src/manifest.ts",
    "src/index.ts",
    "test/plugin.test.ts"
  ] as const;

  await assertTargetDirectoryIsEmpty(request.directory);
  await mkdir(resolve(request.directory, "src"), { recursive: true });
  await mkdir(resolve(request.directory, "test"), { recursive: true });
  await Promise.all([
    writeScaffoldFile(
      request.directory,
      "package.json",
      renderPluginPackageJson(request, cliVersion)
    ),
    writeScaffoldFile(request.directory, "tsconfig.json", tsconfigTemplate()),
    writeScaffoldFile(request.directory, "src/manifest.ts", manifestTemplate(request)),
    writeScaffoldFile(request.directory, "src/index.ts", pluginTemplate(request)),
    writeScaffoldFile(request.directory, "test/plugin.test.ts", pluginTestTemplate(request))
  ]);

  return { name: request.name, directory: request.directory, files };
}

export function renderPluginPackageJson(
  request: PluginScaffoldRequest,
  cliVersion: string
): string {
  assertExactPackageVersion(cliVersion);
  return `${JSON.stringify(
    {
      name: `@tenantscript-plugin/${request.name}`,
      version: "0.1.0",
      type: "module",
      private: true,
      scripts: { build: "tsc --noEmit", test: "vitest run" },
      dependencies: {
        "@tenantscript/manifest": cliVersion,
        "@tenantscript/plugin-sdk": cliVersion
      },
      devDependencies: { typescript: "5.9.3", vitest: "4.1.8" }
    },
    null,
    2
  )}\n`;
}

async function readCliPackageVersion(): Promise<string> {
  try {
    const value: unknown = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8")
    );
    if (typeof value !== "object" || value === null || !("version" in value)) {
      throw new Error("CLI package version is invalid");
    }
    const version = value.version;
    if (typeof version !== "string") throw new Error("CLI package version is invalid");
    assertExactPackageVersion(version);
    return version;
  } catch {
    throw new Error("CLI package version is invalid");
  }
}

function assertExactPackageVersion(version: string): void {
  if (!exactPackageVersionPattern.test(version)) {
    throw new Error("CLI package version is invalid");
  }
}

async function assertTargetDirectoryIsEmpty(directory: string): Promise<void> {
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) throw new Error(`target directory is not empty: ${directory}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function writeScaffoldFile(directory: string, path: string, content: string): Promise<void> {
  await writeFile(resolve(directory, path), content, { flag: "wx" });
}

function tsconfigTemplate(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        skipLibCheck: true
      },
      include: ["src/**/*.ts", "test/**/*.ts"]
    },
    null,
    2
  )}\n`;
}

function manifestTemplate(request: PluginScaffoldRequest): string {
  return `import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = {
  name: "${request.name}",
  version: "0.1.0",
  hooks: [{ name: "${request.hookName}", type: "${request.hookType}", timeoutMs: 250, schemaVersionRange: "^1.0.0" }],
  capabilities: {},
  configSchema: {
    properties: {},
    required: []
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;
`;
}

function pluginTemplate(request: PluginScaffoldRequest): string {
  return `import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";

export const plugin = definePlugin({
  manifest,
  handlers: {
    "${request.hookName}": ${handlerTemplate(request.hookType)}
  }
});

export default plugin;
`;
}

function handlerTemplate(hookType: PluginScaffoldRequest["hookType"]): string {
  if (hookType === "transform") return "async (payload, _context) => payload";
  if (hookType === "policy") {
    return 'async (_payload, _context) => ({ decision: "allow" })';
  }
  return "async (_payload, _context) => undefined";
}

function pluginTestTemplate(request: PluginScaffoldRequest): string {
  // Accepted hook names contain only lowercase alphanumeric dot-separated segments, so this
  // sentinel can never collide with the hook selected by an author or coding agent.
  const undeclaredHookName = "tenantscript.scaffold-undeclared";
  return `import { describe, expect, it, vi } from "vitest";
import { plugin } from "../src/index.js";

describe("${request.name}", () => {
  it("dispatches ${request.hookName} without undeclared capabilities", async () => {
    const capability = vi.fn();
    const result = await plugin.dispatch({
      hookName: "${request.hookName}",
      payload: { id: "evt_1" },
      context: { capability }
    });

    expect(result.ok).toBe(true);
    expect(capability).not.toHaveBeenCalled();
  });

  it("rejects hooks that are not declared in the manifest", async () => {
    const result = await plugin.dispatch({
      hookName: "${undeclaredHookName}",
      payload: { id: "evt_1" },
      context: { capability: vi.fn() }
    });

    expect(result).toEqual({
      ok: false,
      error: { name: "UnknownHookError", hookName: "${undeclaredHookName}" }
    });
  });
});
`;
}
