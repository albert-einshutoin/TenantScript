import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@tenantscript/control-plane/rbac": fileURLToPath(
        new URL("../../packages/control-plane/src/rbac.ts", import.meta.url)
      )
    }
  }
});
