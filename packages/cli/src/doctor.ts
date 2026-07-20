export type DoctorRuntimePrimitive =
  | "cloudflare-workers"
  | "dynamic-workers"
  | "workers-for-platforms";

export interface DoctorReportV1 {
  version: 1;
  profile: "production";
  bindings: {
    DB: boolean;
    ADMIN_MUTATION_RATE_LIMITER_DO: boolean;
  };
  migrations: {
    expected: number[];
    applied: number[];
  };
  permissions: {
    D1_READ: boolean;
    D1_WRITE: boolean;
    WORKERS_SCRIPTS_WRITE: boolean;
  };
  runtime: {
    configured: DoctorRuntimePrimitive;
    supported: DoctorRuntimePrimitive[];
  };
  secrets: {
    ADMIN_CURSOR_SECRET: boolean;
  };
}

export type DoctorFindingCode =
  | "doctor_binding_db_missing"
  | "doctor_binding_rate_limiter_missing"
  | "doctor_migrations_pending"
  | "doctor_permission_d1_read_missing"
  | "doctor_permission_d1_write_missing"
  | "doctor_permission_workers_scripts_write_missing"
  | "doctor_runtime_primitive_unsupported"
  | "doctor_secret_admin_cursor_missing";

export interface DoctorFinding {
  code: DoctorFindingCode;
  severity: "error";
  component: "binding" | "migration" | "permission" | "runtime" | "secret";
  summary: string;
  repair: string;
}

export interface DoctorResult {
  version: 1;
  healthy: boolean;
  findings: DoctorFinding[];
}

const runtimePrimitives: readonly DoctorRuntimePrimitive[] = [
  "cloudflare-workers",
  "dynamic-workers",
  "workers-for-platforms"
];

export function parseDoctorReport(value: unknown): DoctorReportV1 {
  if (
    !isClosedRecord(value, [
      "version",
      "profile",
      "bindings",
      "migrations",
      "permissions",
      "runtime",
      "secrets"
    ])
  ) {
    throw invalidReport();
  }
  if (value.version !== 1) throw invalidReport();
  if (value.profile !== "production") throw invalidReport();
  const bindings = parseBooleanRecord(value.bindings, ["DB", "ADMIN_MUTATION_RATE_LIMITER_DO"]);
  const permissions = parseBooleanRecord(value.permissions, [
    "D1_READ",
    "D1_WRITE",
    "WORKERS_SCRIPTS_WRITE"
  ]);
  const secrets = parseBooleanRecord(value.secrets, ["ADMIN_CURSOR_SECRET"]);
  const migrations = parseMigrations(value.migrations);
  const runtime = parseRuntime(value.runtime);
  return {
    version: 1,
    profile: "production",
    bindings: {
      DB: bindings.DB ?? false,
      ADMIN_MUTATION_RATE_LIMITER_DO: bindings.ADMIN_MUTATION_RATE_LIMITER_DO ?? false
    },
    migrations,
    permissions: {
      D1_READ: permissions.D1_READ ?? false,
      D1_WRITE: permissions.D1_WRITE ?? false,
      WORKERS_SCRIPTS_WRITE: permissions.WORKERS_SCRIPTS_WRITE ?? false
    },
    runtime,
    secrets: { ADMIN_CURSOR_SECRET: secrets.ADMIN_CURSOR_SECRET ?? false }
  };
}

export function evaluateDoctorReport(report: DoctorReportV1): DoctorResult {
  const findings: DoctorFinding[] = [];
  if (!report.bindings.DB) {
    findings.push(
      finding(
        "doctor_binding_db_missing",
        "binding",
        "The Control Plane D1 binding DB is missing.",
        "docs/operations/app-database-routing.md"
      )
    );
  }
  if (!report.bindings.ADMIN_MUTATION_RATE_LIMITER_DO) {
    findings.push(
      finding(
        "doctor_binding_rate_limiter_missing",
        "binding",
        "The admin mutation rate-limiter Durable Object binding is missing.",
        "docs/operations/admin-mutation-rate-limits.md"
      )
    );
  }
  if (report.migrations.applied.length !== report.migrations.expected.length) {
    findings.push(
      finding(
        "doctor_migrations_pending",
        "migration",
        "One or more expected Control Plane migrations are not applied.",
        "docs/reference/configuration.md#control-plane-worker"
      )
    );
  }
  if (!report.permissions.D1_READ) {
    findings.push(
      finding(
        "doctor_permission_d1_read_missing",
        "permission",
        "The deployment identity cannot read D1 resources.",
        "docs/reference/configuration.md#control-plane-worker"
      )
    );
  }
  if (!report.permissions.D1_WRITE) {
    findings.push(
      finding(
        "doctor_permission_d1_write_missing",
        "permission",
        "The deployment identity cannot apply D1 changes.",
        "docs/reference/configuration.md#control-plane-worker"
      )
    );
  }
  if (!report.permissions.WORKERS_SCRIPTS_WRITE) {
    findings.push(
      finding(
        "doctor_permission_workers_scripts_write_missing",
        "permission",
        "The deployment identity cannot publish Worker scripts.",
        "docs/reference/configuration.md#control-plane-worker"
      )
    );
  }
  if (!report.runtime.supported.includes(report.runtime.configured)) {
    findings.push(
      finding(
        "doctor_runtime_primitive_unsupported",
        "runtime",
        "The configured runtime primitive is unavailable in this deployment.",
        "docs/adr/001-runtime-primitive.md"
      )
    );
  }
  if (!report.secrets.ADMIN_CURSOR_SECRET) {
    findings.push(
      finding(
        "doctor_secret_admin_cursor_missing",
        "secret",
        "The Admin API cursor-signing secret is not configured.",
        "docs/reference/configuration.md#control-plane-worker"
      )
    );
  }
  return { version: 1, healthy: findings.length === 0, findings };
}

function parseMigrations(value: unknown): DoctorReportV1["migrations"] {
  if (!isClosedRecord(value, ["expected", "applied"])) throw invalidReport();
  const expected = parseStrictlyIncreasingPositiveIntegers(value.expected, false);
  const applied = parseStrictlyIncreasingPositiveIntegers(value.applied, true);
  if (
    applied.length > expected.length ||
    applied.some((migration, index) => migration !== expected[index])
  ) {
    throw invalidReport();
  }
  return { expected, applied };
}

function parseRuntime(value: unknown): DoctorReportV1["runtime"] {
  if (!isClosedRecord(value, ["configured", "supported"])) throw invalidReport();
  if (!isRuntimePrimitive(value.configured) || !Array.isArray(value.supported)) {
    throw invalidReport();
  }
  const supported: DoctorRuntimePrimitive[] = [];
  for (const primitive of value.supported as unknown[]) {
    if (!isRuntimePrimitive(primitive)) throw invalidReport();
    supported.push(primitive);
  }
  if (supported.length === 0 || new Set(supported).size !== supported.length) throw invalidReport();
  return { configured: value.configured, supported };
}

function parseBooleanRecord(value: unknown, keys: readonly string[]): Record<string, boolean> {
  if (!isClosedRecord(value, keys) || Object.keys(value).length !== keys.length) {
    throw invalidReport();
  }
  const result: Record<string, boolean> = {};
  for (const key of keys) {
    if (typeof value[key] !== "boolean") throw invalidReport();
    result[key] = value[key];
  }
  return result;
}

function parseStrictlyIncreasingPositiveIntegers(value: unknown, allowEmpty: boolean): number[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw invalidReport();
  let previous = 0;
  const parsed: number[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= previous) {
      throw invalidReport();
    }
    parsed.push(entry);
    previous = entry;
  }
  return parsed;
}

function isRuntimePrimitive(value: unknown): value is DoctorRuntimePrimitive {
  return runtimePrimitives.some((primitive) => primitive === value);
}

function isClosedRecord(
  value: unknown,
  allowedKeys: readonly string[]
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function finding(
  code: DoctorFindingCode,
  component: DoctorFinding["component"],
  summary: string,
  repair: string
): DoctorFinding {
  return { code, severity: "error", component, summary, repair };
}

function invalidReport(): Error {
  return new Error("doctor report is invalid");
}
