import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(dirname, "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@tenantscript\/([^/]+)$/,
        replacement: `${workspaceRoot}/packages/$1/src/index.ts`
      }
    ]
  },
  plugins: [
    cloudflareTest(async () => ({
      main: path.join(dirname, "src/worker-entry.ts"),
      miniflare: {
        compatibilityDate: "2026-06-12",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        r2Buckets: ["ARTIFACTS"],
        durableObjects: {
          PROBE_DO: "ProbeDurableObject"
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(dirname, "migrations"))
        }
      }
    }))
  ],
  test: {
    include: ["test/**/*.workers.test.ts"]
  }
});
