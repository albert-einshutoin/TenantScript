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
          ADMIN_ALLOWED_ORIGINS: '["https://admin.example.com"]',
          ADMIN_CURSOR_SECRET: "cursor-secret-must-be-at-least-32-bytes-long",
          ADMIN_IDENTITIES_JSON:
            '{"worker-manager-token":{"subject":"worker-manager","role":"manager","appId":"app_worker","tenantId":"tenant_worker"}}',
          TEST_MIGRATIONS: await readD1Migrations(path.join(dirname, "migrations"))
        }
      }
    }))
  ],
  test: {
    include: ["test/**/*.workers.test.ts"]
  }
});
