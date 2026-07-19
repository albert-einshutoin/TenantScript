import { defineConfig, mergeConfig } from "vitest/config";
import { createPackageVitestConfig } from "@tenantscript/test-config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default mergeConfig(
  createPackageVitestConfig(),
  defineConfig({
    plugins: [react()],
    resolve: {
      alias: {
        "@tenantscript/control-plane/rbac": fileURLToPath(
          new URL("../../packages/control-plane/src/rbac.ts", import.meta.url)
        )
      }
    },
    test: {
      environment: "jsdom",
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"]
    }
  })
);
