import { validRange } from "semver";
import { z } from "zod";
import {
  defaultFailurePolicyForHookType,
  isAllowedFailurePolicy,
  isValidHookConfiguration
} from "./contracts.js";

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const capabilityKeyPattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

const hookCommonShape = {
  name: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  schemaVersionRange: z
    .string()
    .refine((range) => validRange(range) !== null, {
      message: "schemaVersionRange must be a valid semver range"
    })
    .describe(
      "npm-compatible semantic version range; parseManifest is authoritative for semantic validation"
    ),
  priority: z.number().int().optional()
};

const hookSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        ...hookCommonShape,
        type: z.literal("event"),
        failurePolicy: z.literal("record-only").optional()
      })
      .strict(),
    z
      .object({
        ...hookCommonShape,
        type: z.literal("transform"),
        failurePolicy: z.enum(["fail-closed", "use-original"]).optional()
      })
      .strict(),
    z
      .object({
        ...hookCommonShape,
        type: z.literal("policy"),
        failurePolicy: z.literal("fail-closed").optional()
      })
      .strict()
  ])
  .superRefine((hook, context) => {
    const failurePolicy = hook.failurePolicy ?? defaultFailurePolicyForHookType(hook.type);
    if (!isAllowedFailurePolicy(hook.type, failurePolicy)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["failurePolicy"],
        message: `failurePolicy is not allowed for ${hook.type} hooks`
      });
    }

    if (!isValidHookConfiguration(hook.name, hook.type, failurePolicy)) {
      if (hook.name === "webhook.outbound" && hook.type !== "transform") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["type"],
          message: "webhook.outbound must be a transform hook"
        });
      } else if (hook.name === "webhook.outbound") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failurePolicy"],
          message: "webhook.outbound must use fail-closed"
        });
      }
    }
  });

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

export const manifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(semverPattern, "version must be semver-like, e.g. 1.2.3"),
    hooks: z
      .array(hookSchema)
      .min(1)
      .refine((hooks) => new Set(hooks.map((hook) => hook.name)).size === hooks.length, {
        message: "hook names must be unique"
      }),
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
  .strict()
  .describe("Closed TenantScript plugin manifest structure");
