import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspace = process.cwd();
const root = resolve(workspace, "../..");

describe("Template gallery deployment", () => {
  it("uses a static-only Workers Assets contract", () => {
    const config = JSON.parse(readFileSync(resolve(workspace, "wrangler.jsonc"), "utf8")) as Record<
      string,
      unknown
    >;

    expect(Object.keys(config).sort()).toEqual(["$schema", "assets", "compatibility_date", "name"]);
    expect(config.name).toBe("tenantscript-template-gallery");
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(config.assets).toEqual({
      directory: "./dist",
      not_found_handling: "single-page-application"
    });
    for (const forbidden of [
      "main",
      "routes",
      "vars",
      "d1_databases",
      "r2_buckets",
      "durable_objects"
    ]) {
      expect(config[forbidden]).toBeUndefined();
    }
  });

  it("keeps publication explicit, main-only, and deploy-step credentialed", () => {
    const workflow = readFileSync(
      resolve(root, ".github/workflows/template-gallery-publish.yml"),
      "utf8"
    );

    expect(workflow).toMatch(/workflow_dispatch:/u);
    expect(workflow).toMatch(/source_revision:/u);
    expect(workflow).toMatch(/confirm_production_deploy:/u);
    expect(workflow).toMatch(/environment:\s*template-gallery-production/u);
    expect(workflow).toMatch(/github\.ref == 'refs\/heads\/main'/u);
    expect(workflow).toMatch(/inputs\.confirm_production_deploy/u);
    expect(workflow).toMatch(/ref:\s*\$\{\{ inputs\.source_revision \}\}/u);
    expect(workflow).toMatch(/EXPECTED_SOURCE_REVISION/u);
    expect(workflow).toMatch(/git merge-base --is-ancestor/u);
    expect(workflow).toMatch(/pnpm --filter @tenantscript\/template-gallery build/u);
    expect(workflow).toMatch(/wrangler deploy\s+--dry-run/u);
    expect(workflow).toMatch(/wrangler deploy[\s\S]*--strict/u);
    expect(workflow).toMatch(/--autoconfig=false/u);
    expect(workflow).not.toMatch(/(?:pull_request|pull_request_target|schedule|push):/u);

    const deployMarker = "      - name: Deploy static gallery\n";
    const markerIndex = workflow.indexOf(deployMarker);
    expect(markerIndex).toBeGreaterThan(0);
    expect(workflow.slice(0, markerIndex)).not.toMatch(/secrets\./u);
    const deployStep = workflow.slice(markerIndex);
    expect(deployStep).toMatch(/secrets\.CLOUDFLARE_API_TOKEN/u);
    expect(deployStep).toMatch(/secrets\.CLOUDFLARE_ACCOUNT_ID/u);
  });
});
