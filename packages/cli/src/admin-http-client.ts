const MAX_RESPONSE_BYTES = 64 * 1024;

export interface AdminRollbackCommand {
  installationId: string;
  targetVersionId: string;
  expectedRevision: number;
  idempotencyKey: string;
}

export interface AdminRollbackResponse {
  installationId: string;
  pluginKey: string;
  fromVersion: string;
  toVersion: string;
  revision: number;
  auditId: string;
  completedAt: string;
}

export interface AdminApprovalDecisionCommand {
  approvalId: string;
  decision: "approved" | "rejected";
  reason?: string;
}

export interface AdminApprovalDecisionResponse {
  approvalId: string;
  state: "approved" | "rejected";
  auditId: string;
  decidedAt: string;
  installation?: {
    id: string;
    versionId: string;
    pluginKey: string;
    version: string;
    enabled: boolean;
    priority: number;
    revision: 0;
  };
}

export interface AdminMutationClient {
  rollbackAdminInstallation: (request: AdminRollbackCommand) => Promise<AdminRollbackResponse>;
  decideAdminApproval: (
    request: AdminApprovalDecisionCommand
  ) => Promise<AdminApprovalDecisionResponse>;
}

export interface AdminFetchLike {
  (
    input: string,
    init: { method: "POST"; headers: Record<string, string>; body: string }
  ): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;
}

export function createHttpAdminMutationClient(params: {
  baseUrl: string;
  token: string;
  fetchImpl: AdminFetchLike;
}): AdminMutationClient {
  const origin = parseAdminOrigin(params.baseUrl);
  if (!isBearerCredential(params.token) || typeof params.fetchImpl !== "function") {
    throw invalidConfiguration();
  }
  const authorization = `Bearer ${params.token}`;

  return {
    rollbackAdminInstallation: async (request) => {
      validateRollbackCommand(request);
      const response = await sendMutation({
        fetchImpl: params.fetchImpl,
        url: `${origin}/v1/admin/rollbacks`,
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": request.idempotencyKey
        },
        body: JSON.stringify({
          installationId: request.installationId,
          targetVersionId: request.targetVersionId,
          expectedRevision: request.expectedRevision
        })
      });
      return parseRollbackResponse(response);
    },
    decideAdminApproval: async (request) => {
      validateApprovalCommand(request);
      const response = await sendMutation({
        fetchImpl: params.fetchImpl,
        url: `${origin}/v1/admin/approval-decisions`,
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(request)
      });
      return parseApprovalResponse(response);
    }
  };
}

async function sendMutation(params: {
  fetchImpl: AdminFetchLike;
  url: string;
  headers: Record<string, string>;
  body: string;
}): Promise<unknown> {
  let response: Awaited<ReturnType<AdminFetchLike>>;
  try {
    response = await params.fetchImpl(params.url, {
      method: "POST",
      headers: params.headers,
      body: params.body
    });
  } catch {
    throw new Error("Admin mutation request failed");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error("Admin mutation request failed");
  }
  if (text.length > MAX_RESPONSE_BYTES) throw invalidResponse();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    if (response.ok) throw invalidResponse();
    throw requestFailure(response.status);
  }
  if (!response.ok) {
    const code = parsePublicErrorCode(body);
    throw requestFailure(response.status, code);
  }
  return body;
}

function parseAdminOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw invalidConfiguration();
    }
    return url.origin;
  } catch {
    throw invalidConfiguration();
  }
}

function validateRollbackCommand(value: unknown): asserts value is AdminRollbackCommand {
  if (
    !isExactRecord(value, [
      "installationId",
      "targetVersionId",
      "expectedRevision",
      "idempotencyKey"
    ]) ||
    !isNonEmptyString(value.installationId) ||
    !isNonEmptyString(value.targetVersionId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    typeof value.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9._~-]{16,128}$/u.test(value.idempotencyKey)
  ) {
    throw new Error("Admin rollback request is invalid");
  }
}

function validateApprovalCommand(value: unknown): asserts value is AdminApprovalDecisionCommand {
  if (!isRecord(value)) throw new Error("Admin approval request is invalid");
  if (
    !isExactRecord(
      value,
      value.reason === undefined ? ["approvalId", "decision"] : ["approvalId", "decision", "reason"]
    ) ||
    !isNonEmptyString(value.approvalId) ||
    (value.decision !== "approved" && value.decision !== "rejected") ||
    (value.reason !== undefined &&
      (typeof value.reason !== "string" ||
        value.reason.length === 0 ||
        value.reason.length > 1000 ||
        value.reason.trim() !== value.reason))
  ) {
    throw new Error("Admin approval request is invalid");
  }
}

function parseRollbackResponse(value: unknown): AdminRollbackResponse {
  if (
    !isExactRecord(value, [
      "installationId",
      "pluginKey",
      "fromVersion",
      "toVersion",
      "revision",
      "auditId",
      "completedAt"
    ]) ||
    !isNonEmptyString(value.installationId) ||
    !isNonEmptyString(value.pluginKey) ||
    !isNonEmptyString(value.fromVersion) ||
    !isNonEmptyString(value.toVersion) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isNonEmptyString(value.auditId) ||
    !isIsoDate(value.completedAt)
  ) {
    throw invalidResponse();
  }
  return value as unknown as AdminRollbackResponse;
}

function parseApprovalResponse(value: unknown): AdminApprovalDecisionResponse {
  if (!isRecord(value)) throw invalidResponse();
  const keys =
    value.installation === undefined
      ? ["approvalId", "state", "auditId", "decidedAt"]
      : ["approvalId", "state", "auditId", "decidedAt", "installation"];
  if (
    !isExactRecord(value, keys) ||
    !isNonEmptyString(value.approvalId) ||
    (value.state !== "approved" && value.state !== "rejected") ||
    !isNonEmptyString(value.auditId) ||
    !isIsoDate(value.decidedAt) ||
    (value.installation !== undefined && !isInstallationResponse(value.installation))
  ) {
    throw invalidResponse();
  }
  return value as unknown as AdminApprovalDecisionResponse;
}

function isInstallationResponse(value: unknown): boolean {
  return (
    isExactRecord(value, [
      "id",
      "versionId",
      "pluginKey",
      "version",
      "enabled",
      "priority",
      "revision"
    ]) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.versionId) &&
    isNonEmptyString(value.pluginKey) &&
    isNonEmptyString(value.version) &&
    typeof value.enabled === "boolean" &&
    Number.isSafeInteger(value.priority) &&
    value.revision === 0
  );
}

function parsePublicErrorCode(value: unknown): string | undefined {
  if (
    !isExactRecord(value, ["error"]) ||
    !isExactRecord(value.error, ["code", "message"]) ||
    typeof value.error.code !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(value.error.code)
  ) {
    return undefined;
  }
  return value.error.code;
}

function isBearerCredential(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[!-~]+$/u.test(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function invalidConfiguration(): Error {
  return new Error("Admin mutation client configuration is invalid");
}

function invalidResponse(): Error {
  return new Error("Admin mutation response is invalid");
}

function requestFailure(status: number, code?: string): Error {
  return new Error(
    `Admin mutation request failed with HTTP ${String(status)}${code === undefined ? "" : ` (${code})`}`
  );
}
