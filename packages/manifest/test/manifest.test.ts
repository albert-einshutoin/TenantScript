import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  parseManifest,
  resolveGrants,
  validateConfig,
  type TenantScriptManifest
} from "../src/index.js";

const validManifest = {
  name: "large-invoice-notify",
  version: "1.2.3",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
  capabilities: {
    "slack.send": {
      channel: "$config.notifyChannel",
      template: "large_invoice"
    }
  },
  configSchema: {
    properties: {
      notifyChannel: { type: "string" },
      dryRun: { type: "boolean", default: false }
    },
    required: ["notifyChannel"]
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

describe("parseManifest", () => {
  it("accepts a valid manifest", () => {
    const result = parseManifest(validManifest);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("large-invoice-notify");
    }
  });

  it.each([
    ["invalid semver range", { version: "^1.2.3" }, "version"],
    [
      "invalid capability key format",
      { capabilities: { slackSend: {} } },
      "capabilities.slackSend"
    ],
    ["negative cpuMs", { limits: { cpuMs: -1, timeoutMs: 500 } }, "limits.cpuMs"],
    [
      "missing timeoutMs",
      { hooks: [{ name: "invoice.created", type: "event" }] },
      "hooks.0.timeoutMs"
    ],
    ["invalid egress mode", { egress: { mode: "open" } }, "egress.mode"],
    ["empty hooks", { hooks: [] }, "hooks"],
    ["unknown top-level key", { unknown: true }, ""],
    ["invalid version format", { version: "v1" }, "version"]
  ])("rejects %s", (_name, override, path) => {
    const result = parseManifest({ ...validManifest, ...override });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === path)).toBe(true);
    }
  });

  it("returns structured errors instead of throwing for arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = parseManifest(input);
        if (!result.ok) {
          expect(Array.isArray(result.errors)).toBe(true);
        }
      }),
      { numRuns: 1000 }
    );
  });
});

describe("validateConfig", () => {
  it("rejects missing required values", () => {
    const result = validateConfig(validManifest.configSchema, {});

    expect(result).toEqual({
      ok: false,
      errors: [{ path: "notifyChannel", message: "required config value is missing" }]
    });
  });

  it("fills defaults for optional values", () => {
    const result = validateConfig(validManifest.configSchema, { notifyChannel: "C123" });

    expect(result).toEqual({
      ok: true,
      value: { notifyChannel: "C123", dryRun: false }
    });
  });

  it("rejects type mismatches", () => {
    const result = validateConfig(validManifest.configSchema, { notifyChannel: 123 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        path: "notifyChannel",
        message: "expected string, received number"
      });
    }
  });
});

describe("resolveGrants", () => {
  it("resolves $config references in grants", () => {
    const result = resolveGrants(validManifest.capabilities, {
      notifyChannel: "C123",
      dryRun: false
    });

    expect(result).toEqual({
      ok: true,
      value: {
        "slack.send": {
          channel: "C123",
          template: "large_invoice"
        }
      }
    });
  });

  it("rejects unresolved $config references", () => {
    const result = resolveGrants(validManifest.capabilities, { dryRun: false });

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          path: "slack.send.channel",
          message: "config reference $config.notifyChannel is not defined"
        }
      ]
    });
  });
});
