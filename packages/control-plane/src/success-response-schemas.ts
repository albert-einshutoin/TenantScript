export type ControlPlaneJsonSchema = Readonly<Record<string, unknown>>;

const text = { type: "string" } as const;
const nonNegativeInteger = { type: "integer", minimum: 0 } as const;
const integer = { type: "integer" } as const;
const boolean = { type: "boolean" } as const;

function enumString(values: readonly string[]): ControlPlaneJsonSchema {
  return { type: "string", enum: values };
}

function array(items: ControlPlaneJsonSchema): ControlPlaneJsonSchema {
  return { type: "array", items };
}

function object(
  properties: Readonly<Record<string, ControlPlaneJsonSchema>>,
  optional: readonly string[] = []
): ControlPlaneJsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => !optional.includes(key)),
    additionalProperties: false
  };
}

function collection(item: ControlPlaneJsonSchema): ControlPlaneJsonSchema {
  return object({ items: array(item), nextCursor: text }, ["nextCursor"]);
}

function page(section: string, item: ControlPlaneJsonSchema): ControlPlaneJsonSchema {
  return object(
    {
      section: { const: section },
      items: array(item),
      nextCursor: text
    },
    ["nextCursor"]
  );
}

const installationSummary = object({
  id: text,
  pluginKey: text,
  version: text,
  enabled: boolean,
  priority: nonNegativeInteger,
  revision: nonNegativeInteger
});

const pluginVersionSummary = object({
  id: text,
  pluginId: text,
  pluginKey: text,
  version: text,
  artifactHash: text,
  createdAt: text
});

const approvalSummary = object({
  id: text,
  pluginId: text,
  role: text,
  resumeHook: text,
  state: enumString(["pending", "approved", "rejected", "expired"]),
  expiresAt: text,
  createdAt: text
});

const executionStatus = enumString([
  "success",
  "error",
  "timeout",
  "egress_denied",
  "budget_exceeded"
]);

const executionSummary = object({
  id: text,
  pluginId: text,
  hookName: text,
  version: text,
  status: executionStatus,
  durationMs: nonNegativeInteger,
  capabilityNames: array(text),
  createdAt: text
});

const auditStateSummary = object(
  {
    enabled: boolean,
    priority: integer,
    revision: nonNegativeInteger,
    version: text
  },
  ["enabled", "priority", "revision", "version"]
);

const auditEventSummary = object({
  id: text,
  installationId: text,
  pluginId: text,
  revision: nonNegativeInteger,
  actor: text,
  action: text,
  before: auditStateSummary,
  after: auditStateSummary,
  createdAt: text
});

const installationPage = page("installations", installationSummary);
const pluginVersionPage = page("pluginVersions", pluginVersionSummary);
const approvalPage = page("approvals", approvalSummary);
const executionPage = page("executions", executionSummary);
const auditEventPage = page("auditEvents", auditEventSummary);

const providerConnectionSummary = object(
  {
    provider: enumString(["slack"]),
    id: text,
    workspaceId: text,
    workspaceName: text,
    botUserId: text,
    connectedAt: text
  },
  ["workspaceName", "botUserId"]
);

const schemaMigrationBlocker = object({
  installationId: text,
  pluginKey: text,
  pluginVersion: text,
  schemaRange: text
});

const schemaMigrationVersion = object({
  version: text,
  installationCount: nonNegativeInteger,
  removable: boolean,
  blockingInstallations: array(schemaMigrationBlocker)
});

const schemaMigrationStatus = object({
  hookName: text,
  versions: array(schemaMigrationVersion),
  incompatibleInstallations: array(schemaMigrationBlocker)
});

const installationDetail = object({
  id: text,
  pluginKey: text,
  version: text,
  enabled: boolean,
  priority: nonNegativeInteger,
  revision: nonNegativeInteger,
  configFields: array(
    object({
      name: text,
      type: enumString(["string", "number", "boolean"]),
      required: boolean,
      configured: boolean,
      hasDefault: boolean
    })
  ),
  capabilities: array(
    object({
      name: text,
      status: enumString(["granted", "missing"]),
      scopeKeys: array(text),
      configReferences: array(text)
    })
  ),
  egress: object({
    mode: enumString(["deny", "allowlist"]),
    allowlistedHostCount: nonNegativeInteger
  })
});

const installPreview = object({
  versionId: text,
  pluginKey: text,
  version: text,
  configFields: array(
    object({
      name: text,
      type: enumString(["string", "number", "boolean"]),
      required: boolean,
      hasDefault: boolean
    })
  ),
  capabilities: array(
    object({
      name: text,
      scopeKeys: array(text),
      configReferences: array(text)
    })
  ),
  egress: object({
    mode: enumString(["deny", "allowlist"]),
    allowlistedHostCount: nonNegativeInteger
  })
});

const installResult = object({
  id: text,
  versionId: text,
  pluginKey: text,
  version: text,
  enabled: boolean,
  priority: nonNegativeInteger,
  revision: { const: 0 }
});

const executionDetail = object(
  {
    id: text,
    pluginId: text,
    hookName: text,
    version: text,
    status: executionStatus,
    durationMs: nonNegativeInteger,
    errorCode: enumString([
      "execution_failed",
      "execution_timeout",
      "egress_denied",
      "budget_exceeded"
    ]),
    capabilityCalls: array(
      object({
        name: text,
        status: enumString(["success", "denied", "error"])
      })
    ),
    createdAt: text
  },
  ["errorCode"]
);

const approvalInstallation = object({
  id: text,
  versionId: text,
  pluginKey: text,
  version: text,
  enabled: boolean,
  priority: nonNegativeInteger,
  revision: { const: 0 }
});

/**
 * Public JSON Schemas for successful Control Plane REST bodies.
 *
 * They are deliberately static data: production handlers do not validate responses at runtime.
 * Integration tests validate the real serialized responses so schema drift fails before release.
 */
export const CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS = deepFreeze({
  session: object({
    subject: text,
    role: enumString(["owner", "admin", "operator", "viewer", "tenant-admin", "manager"]),
    appId: text,
    tenantId: text
  }),
  dashboard: object({
    installations: collection(installationSummary),
    pluginVersions: collection(pluginVersionSummary),
    approvals: collection(approvalSummary),
    executions: collection(executionSummary),
    usage: object({ date: text, executions: nonNegativeInteger, runtimeMs: nonNegativeInteger }),
    schemaMigrations: array(schemaMigrationStatus),
    telemetry: object({
      enabled: boolean,
      mode: enumString(["disabled", "anonymous-aggregate"]),
      schemaVersion: { const: 1 }
    })
  }),
  dashboardOperations: object({
    date: text,
    totalExecutions: nonNegativeInteger,
    failedExecutions: nonNegativeInteger,
    failureRateBps: { type: "integer", minimum: 0, maximum: 10_000 },
    timeoutExecutions: nonNegativeInteger,
    egressDeniedExecutions: nonNegativeInteger,
    budgetExceededExecutions: nonNegativeInteger
  }),
  dashboardInstallations: installationPage,
  dashboardPluginVersions: pluginVersionPage,
  dashboardApprovals: approvalPage,
  dashboardExecutions: executionPage,
  dashboardAuditEvents: auditEventPage,
  providerConnections: object({ items: array(providerConnectionSummary) }),
  installationReview: installationDetail,
  installationCommand: object({
    id: text,
    enabled: boolean,
    priority: nonNegativeInteger,
    revision: nonNegativeInteger
  }),
  installPreview,
  installCreate: installResult,
  installRequestCreate: object({
    approvalId: text,
    state: { const: "pending" },
    pluginKey: text,
    version: text,
    capabilities: array(text),
    expiresAt: text
  }),
  rollbackCreate: object({
    installationId: text,
    pluginKey: text,
    fromVersion: text,
    toVersion: text,
    revision: nonNegativeInteger,
    auditId: text,
    completedAt: text
  }),
  executionDetail,
  usage: object({
    items: array(
      object({
        tenantId: text,
        pluginId: text,
        date: text,
        executions: nonNegativeInteger,
        cpuMs: nonNegativeInteger,
        subrequests: nonNegativeInteger,
        workflowRuns: nonNegativeInteger
      })
    )
  }),
  approvalDecisionCreate: object(
    {
      approvalId: text,
      state: enumString(["approved", "rejected"]),
      auditId: text,
      decidedAt: text,
      installation: approvalInstallation
    },
    ["installation"]
  ),
  serviceTokenIssue: object({
    id: text,
    token: text,
    label: text,
    role: enumString(["owner", "admin", "operator", "viewer", "tenant-admin"]),
    scopes: array(text),
    createdAt: text,
    expiresAt: text
  })
} as const);

export type ControlPlaneSuccessResponseSchemaId =
  keyof typeof CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
