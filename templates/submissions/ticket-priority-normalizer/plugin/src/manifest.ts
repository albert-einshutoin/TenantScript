import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = {
  name: "ticket-priority-normalizer",
  version: "0.1.0",
  hooks: [
    {
      name: "ticket.created",
      type: "transform",
      timeoutMs: 250,
      schemaVersionRange: "^1.0.0"
    }
  ],
  capabilities: {},
  configSchema: {
    properties: {},
    required: []
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;
