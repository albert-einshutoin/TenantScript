import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes a complete community template submission path", async () => {
  const guide = await readFile("docs/community/plugin-template-submission.md", "utf8");

  for (const required of [
    "templates/submission.schema.json",
    "templates/submissions/<slug>/submission.json",
    "full commit SHA",
    "capabilities",
    "egress",
    "pnpm lint:template-submissions",
    "pnpm test:template-submissions",
    "ext audit --manifest ./manifest.json --package ./package.json --bundle ./dist/plugin.cjs",
    "Plugin human review checklist",
    "not a certification",
    "simulation",
    "community"
  ]) {
    assert.ok(guide.includes(required), `submission guide must include ${required}`);
  }
  assert.doesNotMatch(
    guide,
    /(?:NPM_TOKEN|CLOUDFLARE_API_TOKEN|NODE_AUTH_TOKEN|\/Users\/|\/Volumes\/)/
  );
});

test("links the guide from contributor and plugin-author entry points", async () => {
  const [contributing, docsIndex] = await Promise.all([
    readFile("CONTRIBUTING.md", "utf8"),
    readFile("docs/README.md", "utf8")
  ]);

  assert.match(contributing, /docs\/community\/plugin-template-submission\.md/);
  assert.match(docsIndex, /community\/plugin-template-submission\.md/);
});

test("provides a template-specific pull request checklist", async () => {
  const template = await readFile(".github/PULL_REQUEST_TEMPLATE/plugin-template.md", "utf8");

  for (const required of [
    "Full commit SHA",
    "build",
    "test",
    "ext audit",
    "Capability",
    "Egress",
    "License",
    "review record",
    "Non-guarantees",
    "SECURITY.md"
  ]) {
    assert.ok(template.includes(required), `PR template must include ${required}`);
  }
});
