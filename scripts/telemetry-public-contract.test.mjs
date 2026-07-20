import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("published telemetry schema is closed and anonymous", async () => {
  const schema = JSON.parse(await readFile("docs/reference/telemetry-event.schema.json", "utf8"));

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "generatedAt",
    "productVersion",
    "runtimePrimitive",
    "counts"
  ]);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.properties.runtimePrimitive.enum, [
    "cloudflare-workers",
    "dynamic-workers",
    "workers-for-platforms"
  ]);
  assert.equal(schema.properties.counts.additionalProperties, false);
  assert.deepEqual(schema.properties.counts.required, [
    "enabledInstallations",
    "executions",
    "errors"
  ]);
  assert.equal(schema.properties.counts.properties.errors.additionalProperties, false);
  assert.deepEqual(schema.properties.counts.properties.errors.required, [
    "runtime",
    "timeout",
    "egressDenied",
    "budgetExceeded"
  ]);
  assert.deepEqual(Object.keys(schema.properties), [
    "schemaVersion",
    "generatedAt",
    "productVersion",
    "runtimePrimitive",
    "counts"
  ]);
});

test("privacy documentation makes opt-in and receiver limits explicit", async () => {
  const privacy = await readFile("docs/privacy/telemetry.md", "utf8");

  assert.match(privacy, /off by default/i);
  assert.match(privacy, /TENANTSCRIPT_TELEMETRY_ENABLED=true/);
  assert.match(privacy, /TENANTSCRIPT_TELEMETRY_ENDPOINT/);
  assert.match(privacy, /TENANTSCRIPT_PRODUCT_VERSION/);
  assert.match(privacy, /TENANTSCRIPT_RUNTIME_PRIMITIVE/);
  assert.match(privacy, /persistent deployment identifier/);
  assert.match(privacy, /receiver can still observe ordinary connection metadata/i);
  assert.match(privacy, /additionalProperties: false/);
});

test("adopter and feedback paths require public consent and safe disclosure", async () => {
  const [adopters, contributing, adopterTemplate, bug, feedback, hardening] = await Promise.all([
    readFile("ADOPTERS.md", "utf8"),
    readFile("CONTRIBUTING.md", "utf8"),
    readFile(".github/PULL_REQUEST_TEMPLATE/adopter-report.md", "utf8"),
    readFile(".github/ISSUE_TEMPLATE/bug.yml", "utf8"),
    readFile(".github/ISSUE_TEMPLATE/feedback.yml", "utf8"),
    readFile(".github/ISSUE_TEMPLATE/security-adjacent.yml", "utf8")
  ]);

  assert.match(adopters, /explicit public opt-in/i);
  assert.match(adopters, /PULL_REQUEST_TEMPLATE\/adopter-report\.md/);
  assert.match(adopters, /issues\/new\?template=feedback\.yml/);
  assert.match(adopters, /SECURITY\.md/);
  assert.match(contributing, /ADOPTERS\.md/);
  assert.match(contributing, /adopter report/i);
  assert.match(adopterTemplate, /authorized to publish/i);
  assert.match(adopterTemplate, /customer\/tenant data/i);

  for (const template of [bug, feedback, hardening]) {
    assert.match(template, /required: true/);
    assert.match(template, /credential/i);
    assert.match(template, /customer\/tenant data/i);
  }
  assert.match(bug, /Minimal reproduction/);
  assert.match(bug, /Runtime primitive/);
  assert.match(bug, /Redacted self-host configuration/);
  assert.match(bug, /Security impact/);
  assert.match(hardening, /not an undisclosed exploitable vulnerability/i);
});
