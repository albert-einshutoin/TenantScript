import { defineConfig, mergeConfig } from "vitest/config";
import { createPackageVitestConfig } from "@tenantscript/test-config";
import react from "@vitejs/plugin-react";

export default mergeConfig(
  createPackageVitestConfig(),
  defineConfig({
    plugins: [react()],
    test: {
      environment: "jsdom",
      setupFiles: ["src/test/setup.ts"],
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"]
    }
  })
);
