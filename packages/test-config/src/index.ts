import { defineConfig } from "vitest/config";

export function createPackageVitestConfig() {
  const workspaceRoot = new URL("../../../", import.meta.url).pathname;

  return defineConfig({
    resolve: {
      alias: [
        {
          find: /^@tenantscript\/([^/]+)$/,
          replacement: `${workspaceRoot}packages/$1/src/index.ts`
        }
      ]
    },
    test: {
      coverage: {
        provider: "v8",
        reporter: ["text", "lcov"],
        include: ["src/**/*.ts"],
        thresholds: {
          lines: 80,
          functions: 80,
          branches: 80,
          statements: 80
        }
      }
    }
  });
}
