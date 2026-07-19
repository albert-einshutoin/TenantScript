import { z } from "zod";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const capabilityKeyPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const configReferencePattern = /^\$config\.([A-Za-z_][A-Za-z0-9_]*)$/;

const hookSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(["event", "transform", "policy"]),
    timeoutMs: z.number().int().positive(),
    priority: z.number().int().optional()
  })
  .strict();

const configFieldSchema = z
  .object({
    type: z.enum(["string", "number", "boolean"]),
    default: z.union([z.string(), z.number(), z.boolean()]).optional()
  })
  .strict()
  .refine((field) => field.default === undefined || typeof field.default === field.type, {
    message: "default value must match the declared config type",
    path: ["default"]
  });

export const configSchemaSpec = z
  .object({
    properties: z.record(z.string().min(1), configFieldSchema),
    required: z.array(z.string().min(1)).default([])
  })
  .strict();

const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(semverPattern, "version must be semver-like, e.g. 1.2.3"),
    hooks: z.array(hookSchema).min(1),
    capabilities: z.record(
      z.string().regex(capabilityKeyPattern),
      z.record(z.string(), z.unknown())
    ),
    configSchema: configSchemaSpec,
    egress: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("deny") }).strict(),
      z.object({ mode: z.literal("allowlist"), hosts: z.array(z.string().min(1)).min(1) }).strict()
    ]),
    limits: z
      .object({
        cpuMs: z.number().int().positive(),
        timeoutMs: z.number().int().positive()
      })
      .strict()
  })
  .strict();

export type ConfigSchemaSpec = z.infer<typeof configSchemaSpec>;
export type TenantScriptManifest = z.infer<typeof manifestSchema>;
export type InstallationConfig = Record<string, string | number | boolean>;
export type GrantMap = Record<string, Record<string, unknown>>;

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      errors: ValidationIssue[];
    };

export function parseManifest(input: unknown): ValidationResult<TenantScriptManifest> {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  return { ok: false, errors: formatZodErrors(parsed.error) };
}

export function validateConfig(
  schemaInput: unknown,
  configInput: unknown
): ValidationResult<InstallationConfig> {
  const schemaResult = configSchemaSpec.safeParse(schemaInput);
  if (!schemaResult.success) {
    return { ok: false, errors: formatZodErrors(schemaResult.error) };
  }

  const configResult = z.record(z.string(), z.unknown()).safeParse(configInput);
  if (!configResult.success) {
    return { ok: false, errors: formatZodErrors(configResult.error) };
  }

  const schema = schemaResult.data;
  const input = configResult.data;
  const config: InstallationConfig = {};
  const errors: ValidationIssue[] = [];

  for (const [name, field] of Object.entries(schema.properties)) {
    const providedValue = input[name];

    if (providedValue === undefined) {
      if (schema.required.includes(name)) {
        errors.push({ path: name, message: "required config value is missing" });
      } else if (field.default !== undefined) {
        config[name] = field.default;
      }
      continue;
    }

    if (!isConfigPrimitiveOfType(providedValue, field.type)) {
      errors.push({
        path: name,
        message: `expected ${field.type}, received ${typeof providedValue}`
      });
      continue;
    }

    config[name] = providedValue;
  }

  for (const name of Object.keys(input)) {
    if (!(name in schema.properties)) {
      errors.push({ path: name, message: "unknown config key" });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: config };
}

export function resolveGrants(
  capabilities: GrantMap,
  config: InstallationConfig
): ValidationResult<GrantMap> {
  const errors: ValidationIssue[] = [];
  const resolved: GrantMap = {};

  for (const [capability, grant] of Object.entries(capabilities)) {
    const resolvedGrant = resolveGrantValue(grant, config, capability, errors);
    if (isRecord(resolvedGrant)) {
      resolved[capability] = resolvedGrant;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: resolved };
}

function resolveGrantValue(
  value: unknown,
  config: InstallationConfig,
  path: string,
  errors: ValidationIssue[]
): unknown {
  if (typeof value === "string") {
    const match = configReferencePattern.exec(value);
    if (match === null) {
      return value;
    }

    const key = match[1];
    if (key === undefined) {
      errors.push({ path, message: `config reference ${value} is malformed` });
      return value;
    }

    const resolved = config[key];
    if (resolved === undefined) {
      errors.push({ path, message: `config reference ${value} is not defined` });
      return value;
    }

    return resolved;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      resolveGrantValue(entry, config, `${path}.${String(index)}`, errors)
    );
  }

  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = resolveGrantValue(nested, config, `${path}.${key}`, errors);
    }
    return output;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConfigPrimitiveOfType(
  value: unknown,
  type: "string" | "number" | "boolean"
): value is string | number | boolean {
  return typeof value === type;
}

function formatZodErrors(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));
}
