export type JsonSchemaValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonSchemaValue[]
  | { readonly [key: string]: JsonSchemaValue };

export interface TenantScriptManifestJsonSchema {
  readonly [key: string]: JsonSchemaValue;
  readonly $schema: "http://json-schema.org/draft-07/schema#";
  readonly $id: "https://raw.githubusercontent.com/albert-einshutoin/TenantScript/main/docs/reference/tenantscript-manifest.schema.json";
  readonly title: "TenantScript plugin manifest";
  readonly description: string;
}

export const tenantScriptManifestJsonSchema: TenantScriptManifestJsonSchema = deepFreeze({
  type: "object",
  properties: {
    name: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]*$"
    },
    version: {
      type: "string",
      pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?$"
    },
    hooks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
            minLength: 1
          },
          type: {
            type: "string",
            enum: ["event", "transform", "policy"]
          },
          timeoutMs: {
            type: "integer",
            exclusiveMinimum: 0
          },
          schemaVersionRange: {
            type: "string",
            description:
              "npm-compatible semantic version range; parseManifest is authoritative for semantic validation"
          },
          priority: {
            type: "integer"
          }
        },
        required: ["name", "type", "timeoutMs", "schemaVersionRange"],
        additionalProperties: false
      },
      minItems: 1
    },
    capabilities: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: {}
      },
      propertyNames: {
        pattern: "^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$"
      }
    },
    configSchema: {
      type: "object",
      properties: {
        properties: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: ["string", "number", "boolean"]
              },
              default: {
                type: ["string", "number", "boolean"]
              }
            },
            required: ["type"],
            additionalProperties: false
          },
          propertyNames: {
            minLength: 1
          }
        },
        required: {
          type: "array",
          items: {
            type: "string",
            minLength: 1
          },
          default: []
        }
      },
      required: ["properties"],
      additionalProperties: false
    },
    egress: {
      anyOf: [
        {
          type: "object",
          properties: {
            mode: {
              type: "string",
              const: "deny"
            }
          },
          required: ["mode"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: {
            mode: {
              type: "string",
              const: "allowlist"
            },
            hosts: {
              type: "array",
              items: {
                type: "string",
                minLength: 1
              },
              minItems: 1
            }
          },
          required: ["mode", "hosts"],
          additionalProperties: false
        }
      ]
    },
    limits: {
      type: "object",
      properties: {
        cpuMs: {
          type: "integer",
          exclusiveMinimum: 0
        },
        timeoutMs: {
          type: "integer",
          exclusiveMinimum: 0
        }
      },
      required: ["cpuMs", "timeoutMs"],
      additionalProperties: false
    }
  },
  required: ["name", "version", "hooks", "capabilities", "configSchema", "egress", "limits"],
  additionalProperties: false,
  description:
    "Canonical structural schema. Use parseManifest for complete semantic validation, including npm-compatible semver ranges.",
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://raw.githubusercontent.com/albert-einshutoin/TenantScript/main/docs/reference/tenantscript-manifest.schema.json",
  title: "TenantScript plugin manifest"
});

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  // Consumers share this public schema object. Recursively freezing it prevents one validation
  // tool from mutating nested constraints and silently changing another tool's contract.
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
