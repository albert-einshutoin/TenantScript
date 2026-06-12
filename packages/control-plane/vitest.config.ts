import { defineConfig, mergeConfig } from "vitest/config";
import { createPackageVitestConfig } from "@tenantscript/test-config";

export default mergeConfig(
  createPackageVitestConfig(),
  defineConfig({
    test: {
      include: ["test/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.workers.test.ts"]
    }
  })
);
