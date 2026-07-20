import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const guideUrl = new URL("../docs/contributing/test-selection.md", import.meta.url);

const areaCommands = new Map([
  ["Docs", ["pnpm test:docs", "pnpm verify"]],
  ["Manifest", ["pnpm --filter @tenantscript/manifest test", "pnpm verify"]],
  [
    "SDK",
    [
      "pnpm --filter @tenantscript/plugin-sdk test",
      "pnpm --filter @tenantscript/host-sdk test",
      "pnpm verify"
    ]
  ],
  ["Capability", ["pnpm --filter @tenantscript/capabilities test", "pnpm verify"]],
  ["Loader", ["pnpm --filter @tenantscript/loader test", "pnpm verify"]],
  ["Control plane", ["pnpm --filter @tenantscript/control-plane test", "pnpm verify"]],
  ["Admin UI", ["pnpm --filter @tenantscript/admin-ui test", "pnpm verify"]],
  ["Proxy", ["pnpm --filter @tenantscript/proxy test", "pnpm verify"]],
  ["CLI", ["pnpm --filter @tenantscript/cli test", "pnpm verify"]],
  ["Security-sensitive", ["pnpm test:security", "pnpm verify"]]
]);

test("maps every change area to focused iteration and the final repository gate", async () => {
  const guide = await readFile(guideUrl, "utf8");

  for (const [area, commands] of areaCommands) {
    const row = tableRow(guide, area);
    for (const command of commands) {
      assert.ok(row.includes(`\`${command}\``), `${area}: missing command ${command}`);
    }
  }
});

test("separates accountless Tier 1 from credentialed Tier 2", async () => {
  const guide = await readFile(guideUrl, "utf8");

  assert.match(guide, /Tier 1[^.]*accountless/iu);
  assert.match(guide, /Tier 2[^.]*live/iu);
  assert.match(guide, /Tier 2[^.]*(?:credential|secret)/iu);
  assert.match(guide, /Tier 2[^.]*(?:maintainer|fork)/iu);
  assert.match(guide, /`pnpm verify`[^.]*(?:final|required|必須)/iu);
  assert.doesNotMatch(guide, /\bsleep\s+\d+/u);
  assert.doesNotMatch(guide, /\/Volumes\/|\/Users\//u);
});

test("publishes the selection guide from CONTRIBUTING", async () => {
  const contributing = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
  assert.match(contributing, /\(docs\/contributing\/test-selection\.md\)/u);
});

function tableRow(markdown, area) {
  const row = markdown
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`**${area}**`));
  assert.notEqual(row, undefined, `missing change-area row: ${area}`);
  return row ?? "";
}
