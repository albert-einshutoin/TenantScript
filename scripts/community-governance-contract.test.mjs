import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("publishes a private and enforceable conduct path", async () => {
  const conduct = await readFile("CODE_OF_CONDUCT.md", "utf8");

  assert.match(conduct, /Contributor Covenant Code of Conduct/);
  assert.match(conduct, /version\s+2\.1/i);
  assert.match(conduct, /security\/advisories\/new/);
  assert.match(conduct, /confidential/i);
  assert.match(conduct, /temporary or\s+permanent ban/i);
});

test("documents complete maintainer governance", async () => {
  const governance = await readFile("GOVERNANCE.md", "utf8");

  for (const heading of [
    "## Roles",
    "## Decision process",
    "## Release decisions",
    "## Conflicts of interest",
    "## Inactivity and removal",
    "## Becoming a co-maintainer"
  ]) {
    assert.match(governance, new RegExp(heading));
  }
  assert.match(governance, /CODE_OF_CONDUCT\.md/);
  assert.match(governance, /SECURITY\.md/);
});

test("keeps contributor and newcomer entry points discoverable", async () => {
  const [contributing, pullRequest, index] = await Promise.all([
    readFile("CONTRIBUTING.md", "utf8"),
    readFile(".github/PULL_REQUEST_TEMPLATE.md", "utf8"),
    readFile("docs/community/good-first-issues.md", "utf8")
  ]);

  assert.match(contributing, /CODE_OF_CONDUCT\.md/);
  assert.match(contributing, /good-first-issues\.md/);
  assert.match(pullRequest, /CODE_OF_CONDUCT\.md/);

  const issueLinks = new Set(
    index.match(/https:\/\/github\.com\/albert-einshutoin\/TenantScript\/issues\/\d+/g) ?? []
  );
  assert.ok(
    issueLinks.size >= 10,
    `expected at least 10 unique good-first issues, got ${issueLinks.size}`
  );
  assert.match(index, /Why it matters/);
  assert.match(index, /Verification/);
  assert.match(index, /Definition of Done/);
});
