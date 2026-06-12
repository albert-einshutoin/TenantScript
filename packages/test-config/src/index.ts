import { defineConfig } from "vitest/config";

export function createPackageVitestConfig() {
  return defineConfig({
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
