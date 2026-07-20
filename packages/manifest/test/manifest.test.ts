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
  hooks: [
    {
      name: "invoice.created",
      type: "event",
      timeoutMs: 250,
      schemaVersionRange: "^1.0.0"
    }
  ],
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

const sentinelSecret = "ts_sentinel_secret_must_not_leak";

interface ManifestBoundaryCase {
  name: string;
  createInput: () => unknown;
  expected: { path: string; message: string };
}

const manifestBoundaryCases: readonly ManifestBoundaryCase[] = [
  {
    name: "fractional hook timeout",
    createInput: () =>
      manifestWithSentinel({
        hooks: [{ ...validManifest.hooks[0], timeoutMs: 1.5 }]
      }),
    expected: { path: "hooks.0.timeoutMs", message: "Expected integer, received float" }
  },
  {
    name: "fractional hook priority",
    createInput: () =>
      manifestWithSentinel({
        hooks: [{ ...validManifest.hooks[0], priority: 1.5 }]
      }),
    expected: { path: "hooks.0.priority", message: "Expected integer, received float" }
  },
  {
    name: "empty egress allowlist",
    createInput: () => manifestWithSentinel({ egress: { mode: "allowlist", hosts: [] } }),
    expected: { path: "egress.hosts", message: "Array must contain at least 1 element(s)" }
  },
  {
    name: "empty egress allowlist host",
    createInput: () => manifestWithSentinel({ egress: { mode: "allowlist", hosts: [""] } }),
    expected: { path: "egress.hosts.0", message: "String must contain at least 1 character(s)" }
  },
  {
    name: "zero execution timeout",
    createInput: () => manifestWithSentinel({ limits: { cpuMs: 50, timeoutMs: 0 } }),
    expected: { path: "limits.timeoutMs", message: "Number must be greater than 0" }
  },
  {
    name: "empty required config key",
    createInput: () =>
      manifestWithSentinel({
        configSchema: { ...validManifest.configSchema, required: [""] }
      }),
    expected: {
      path: "configSchema.required.0",
      message: "String must contain at least 1 character(s)"
    }
  },
  {
    name: "empty config property key",
    createInput: () =>
      manifestWithSentinel({
        configSchema: { properties: { "": { type: "string" } }, required: [] }
      }),
    expected: {
      path: "configSchema.properties.",
      message: "String must contain at least 1 character(s)"
    }
  },
  {
    name: "unknown hook field",
    createInput: () =>
      manifestWithSentinel({
        hooks: [{ ...validManifest.hooks[0], sentinelField: sentinelSecret }]
      }),
    expected: {
      path: "hooks.0",
      message: "Unrecognized key(s) in object: 'sentinelField'"
    }
  },
  {
    name: "unknown limits field",
    createInput: () =>
      manifestWithSentinel({
        limits: { ...validManifest.limits, sentinelField: sentinelSecret }
      }),
    expected: {
      path: "limits",
      message: "Unrecognized key(s) in object: 'sentinelField'"
    }
  }
];

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
    [
      "missing hook schema range",
      { hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }] },
      "hooks.0.schemaVersionRange"
    ],
    ["invalid egress mode", { egress: { mode: "open" } }, "egress.mode"],
    [
      "config default not matching declared type",
      {
        configSchema: {
          properties: { dryRun: { type: "boolean", default: "nope" } },
          required: []
        }
      },
      "configSchema.properties.dryRun.default"
    ],
    ["empty hooks", { hooks: [] }, "hooks"],
    ["duplicate hook names", { hooks: [validManifest.hooks[0], validManifest.hooks[0]] }, "hooks"],
    ["unknown top-level key", { unknown: true }, ""],
    ["invalid version format", { version: "v1" }, "version"],
    [
      "invalid hook schema range",
      {
        hooks: [
          {
            name: "invoice.created",
            type: "event",
            timeoutMs: 250,
            schemaVersionRange: "latest"
          }
        ]
      },
      "hooks.0.schemaVersionRange"
    ]
  ])("rejects %s", (_name, override, path) => {
    const result = parseManifest({ ...validManifest, ...override });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === path)).toBe(true);
    }
  });

  it.each(manifestBoundaryCases)(
    "rejects $name with a stable redacted issue",
    ({ createInput, expected }) => {
      const result = parseManifest(createInput());

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("invalid manifest was accepted");
      expect(result.errors).toEqual([expected]);
      expect(JSON.stringify(result)).not.toContain(sentinelSecret);
    }
  );

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

function manifestWithSentinel(override: Record<string, unknown>): unknown {
  return {
    ...validManifest,
    capabilities: {
      ...validManifest.capabilities,
      "slack.send": {
        ...validManifest.capabilities["slack.send"],
        sentinelPayload: sentinelSecret
      }
    },
    ...override
  };
}

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

  it("rejects schemas whose default does not match the declared type", () => {
    const result = validateConfig(
      {
        properties: { retries: { type: "number", default: "not-a-number" } },
        required: []
      },
      {}
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.path === "properties.retries.default")).toBe(true);
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
