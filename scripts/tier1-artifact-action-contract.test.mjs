import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../.github/workflows/tier1.yml", import.meta.url);

test("Tier 1 uploads artifacts with the Node.js 24 action without widening artifact boundaries", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.doesNotMatch(workflow, /actions\/upload-artifact@v4/u);
  assert.equal(workflow.match(/actions\/upload-artifact@v6/gu)?.length, 4);

  assert.match(
    workflow,
    /uses: actions\/upload-artifact@v6\n\s+with:\n\s+name: plugin-authoring-judge-image-evidence-\$\{\{ github\.sha \}\}\n\s+path: \.tmp\/plugin-authoring-judge-image-evidence\n\s+if-no-files-found: error\n\s+include-hidden-files: true\n\s+retention-days: 14/u
  );
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@v6\n\s+if: failure\(\) && steps\.template-gallery\.outcome == 'failure'\n\s+with:\n\s+name: template-gallery-failure-\$\{\{ github\.sha \}\}/u
  );
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@v6\n\s+if: failure\(\) && steps\.admin-ui-visual\.outcome == 'failure'\n\s+with:\n\s+name: admin-ui-visual-failure-\$\{\{ github\.sha \}\}/u
  );
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@v6\n\s+with:\n\s+name: tenantscript-sbom-\$\{\{ github\.sha \}\}\n\s+path: \.tmp\/release-artifacts\/tenantscript\.cdx\.json\n\s+if-no-files-found: error\n\s+retention-days: 14/u
  );
});

test("Tier 1 scans both the workspace lockfile and judge image SBOM with OSV", async () => {
  const workflow = await readFile(workflowUrl, "utf8");

  assert.match(
    workflow,
    /google\/osv-scanner-action\/osv-scanner-action@6e4298ebc4db23e847df9b2e2de2939d6f066c67/u
  );
  assert.match(workflow, /--lockfile=pnpm-lock\.yaml/u);
  assert.match(
    workflow,
    /--lockfile=\.tmp\/plugin-authoring-judge-image-evidence\/judge-image\.cdx\.json/u
  );
  assert.equal(workflow.match(/--lockfile=/gu)?.length, 2);
  assert.doesNotMatch(workflow, /--sbom=/u);
});
