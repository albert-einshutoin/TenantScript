import type { GrantMap, InstallationConfig, TenantScriptManifest } from "@tenantscript/manifest";
import { parseManifest, resolveGrants, validateConfig } from "@tenantscript/manifest";
import type {
  AppRecord,
  InstallationRecord,
  PluginRecord,
  PluginVersionRecord,
  TenantRecord
} from "./storage.js";
import { resolveApprovalDecisionTransition } from "./approval-state.js";
import type { ApprovalDecision, ApprovalState } from "./approval-state.js";
import type { SecretRef, SecretStore } from "./secret-store.js";
import type { SlackConnectionRecord, SlackConnectionStore } from "./slack-connection-store.js";
import type {
  DailyUsageSummary,
  GetDailyUsageSummariesRequest,
  GetDailyUsageSummaryRequest,
  RecordUsageMetricRequest,
  UsageMeter
} from "./usage-meter.js";
import { canRolePerform, normalizeRbacRole, type RbacOperation } from "./rbac.js";

export type { ApprovalDecision, ApprovalState } from "./approval-state.js";

export interface ControlPlaneStore {
  createApp: (record: AppRecord) => Promise<AppRecord>;
  findAppById: (id: string) => Promise<AppRecord | null>;
  createTenant: (record: TenantRecord) => Promise<TenantRecord>;
  findTenantById: (id: string) => Promise<TenantRecord | null>;
  createPlugin: (record: PluginRecord) => Promise<PluginRecord>;
  findPluginByKey: (query: { appId: string; key: string }) => Promise<PluginRecord | null>;
  createPluginVersion: (record: PluginVersionRecord) => Promise<PluginVersionRecord>;
  findPluginVersionById: (id: string) => Promise<PluginVersionRecord | null>;
  findPluginVersion: (query: {
    pluginId: string;
    version: string;
  }) => Promise<PluginVersionRecord | null>;
  listPluginVersions: (query: { pluginId: string }) => Promise<readonly PluginVersionRecord[]>;
  createInstallation: (record: InstallationRecord) => Promise<InstallationRecord>;
  findInstallationById: (id: string) => Promise<InstallationRecord | null>;
  updateInstallationConfig: (request: {
    id: string;
    config: Record<string, unknown>;
    grants: Record<string, unknown>;
  }) => Promise<InstallationRecord>;
  setInstallationEnabled: (request: {
    id: string;
    enabled: boolean;
  }) => Promise<InstallationRecord>;
  updateInstallationPriority: (request: {
    id: string;
    priority: number;
  }) => Promise<InstallationRecord>;
  updateInstallationVersion: (request: {
    id: string;
    pluginVersionId: string;
  }) => Promise<InstallationRecord>;
  createApproval: (record: ApprovalRecord) => Promise<ApprovalRecord>;
  findApprovalById: (id: string) => Promise<ApprovalRecord | null>;
  decideApproval: (request: {
    id: string;
    decision: ApprovalDecision;
    decidedBy: string;
    decisionReason?: string;
    decidedAt: Date;
  }) => Promise<ApprovalRecord>;
  writeExecution: (record: ControlPlaneExecutionRecord) => Promise<ControlPlaneExecutionRecord>;
}

export interface ArtifactStore {
  putArtifact: (
    hash: string,
    content: string | ArrayBuffer | Uint8Array
  ) => Promise<{ hash: string }>;
}

export interface ContinuationRunner {
  runApprovalContinuation: (
    request: ApprovalContinuationRequest
  ) => Promise<ControlPlaneExecutionRecord>;
}

export interface AuthenticatedIdentity {
  subject: string;
  role: string;
  appId?: string;
  tenantId?: string;
  allowedOperations?: readonly RbacOperation[];
}

export interface IdentityResolver {
  resolveToken: (
    token: string
  ) => Promise<AuthenticatedIdentity | null> | AuthenticatedIdentity | null;
}

export interface SlackOAuthTokenResponse {
  accessToken: string;
  workspaceId: string;
  workspaceName?: string;
  botUserId?: string;
}

export interface SlackOAuthClient {
  exchangeCode: (request: {
    code: string;
    redirectUri: string;
  }) => Promise<SlackOAuthTokenResponse> | SlackOAuthTokenResponse;
}

export interface ControlPlaneApi {
  createApp: (request: CreateAppRequest) => Promise<AppRecord>;
  createTenant: (request: CreateTenantRequest) => Promise<TenantRecord>;
  registerPlugin: (request: RegisterPluginRequest) => Promise<PluginRecord>;
  registerPluginVersion: (request: RegisterPluginVersionRequest) => Promise<PluginVersionRecord>;
  listPluginVersions: (
    request: ListPluginVersionsRequest
  ) => Promise<readonly PluginVersionRecord[]>;
  installPlugin: (request: InstallPluginRequest) => Promise<InstallationRecord>;
  updateInstallationConfig: (
    request: UpdateInstallationConfigRequest
  ) => Promise<InstallationRecord>;
  setInstallationEnabled: (request: SetInstallationEnabledRequest) => Promise<InstallationRecord>;
  updateInstallationPriority: (
    request: UpdateInstallationPriorityRequest
  ) => Promise<InstallationRecord>;
  connectSlackWorkspace: (request: ConnectSlackWorkspaceRequest) => Promise<SlackConnectionRecord>;
  rollbackInstallation: (request: RollbackInstallationRequest) => Promise<RollbackResult>;
  decideApproval: (request: DecideApprovalRequest) => Promise<ApprovalRecord>;
  recordExecutionUsage: (request: RecordUsageMetricRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummary: (request: GetDailyUsageSummaryRequest) => Promise<DailyUsageSummary>;
  getDailyUsageSummaries: (
    request: GetDailyUsageSummariesRequest
  ) => Promise<readonly DailyUsageSummary[]>;
}

export interface CreateAppRequest {
  id: string;
  name: string;
}

export interface CreateTenantRequest {
  id: string;
  appId: string;
  name: string;
}

export interface RegisterPluginRequest {
  appId: string;
  key: string;
}

export interface RegisterPluginVersionRequest {
  appId: string;
  pluginKey: string;
  version: string;
  manifest: unknown;
  artifactHash: string;
  artifact: string | ArrayBuffer | Uint8Array;
}

export interface ListPluginVersionsRequest {
  appId: string;
  pluginKey: string;
}

export interface InstallPluginRequest {
  id: string;
  appId: string;
  tenantId: string;
  pluginKey: string;
  version: string;
  config: Record<string, unknown>;
  grants: Record<string, unknown>;
  priority: number;
  enabled?: boolean;
}

export interface UpdateInstallationConfigRequest {
  id: string;
  config: Record<string, unknown>;
}

export interface SetInstallationEnabledRequest {
  id: string;
  enabled: boolean;
}

export interface UpdateInstallationPriorityRequest {
  id: string;
  priority: number;
}

export interface ConnectSlackWorkspaceRequest {
  appId: string;
  tenantId: string;
  code: string;
  redirectUri: string;
  connectedAt?: Date;
}

export interface RollbackInstallationRequest {
  auditId: string;
  appId: string;
  installationId: string;
  pluginKey: string;
  targetVersion: string;
  actor: string;
  reason?: string;
  createdAt?: Date;
}

export interface ApprovalRecord {
  id: string;
  tenantId: string;
  pluginId: string;
  role: string;
  subject: Record<string, unknown>;
  resumeHook: string;
  state: ApprovalState;
  expiresAt: Date;
  createdAt: Date;
  decidedBy?: string;
  decisionReason?: string;
  decidedAt?: Date;
}

export interface DecideApprovalRequest {
  id: string;
  tenantId: string;
  decision: ApprovalDecision;
  actor: string;
  auditId: string;
  reason?: string;
  decidedAt?: Date;
  authToken?: string;
  role?: string;
}

export interface ApprovalDecisionPayload {
  approvalId: string;
  decision: ApprovalDecision;
  subject: Record<string, unknown>;
  decidedBy: string;
  reason?: string;
}

export interface ApprovalContinuationRequest {
  approval: ApprovalRecord;
  payload: ApprovalDecisionPayload;
  decidedAt: Date;
}

export interface RollbackAuditRecord {
  id: string;
  tenantId: string;
  pluginId: string;
  hookName: "installation.rollback";
  version: string;
  status: "success";
  durationMs: 0;
  error: string;
  capabilityCalls: readonly [{ name: "rollback"; status: "success" }];
  createdAt: Date;
}

export interface ControlPlaneExecutionRecord {
  id: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: "success" | "error" | "timeout" | "egress_denied" | "budget_exceeded";
  durationMs: number;
  error?: string;
  capabilityCalls: readonly { name: string; status: "success" | "denied" | "error" }[];
  createdAt: Date;
}

export interface RollbackResult {
  installation: InstallationRecord;
  audit: RollbackAuditRecord;
}

export type ControlPlaneErrorStatus = 400 | 403 | 404 | 409 | 500;

export interface ControlPlaneErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export interface ControlPlaneErrorResponse {
  status: ControlPlaneErrorStatus;
  body: ControlPlaneErrorEnvelope;
}

export class ControlPlaneApiError extends Error {
  override readonly name = "ControlPlaneApiError";

  constructor(
    readonly status: Exclude<ControlPlaneErrorStatus, 500>,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function toControlPlaneErrorResponse(error: unknown): ControlPlaneErrorResponse {
  if (error instanceof ControlPlaneApiError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message
        }
      }
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "internal control-plane error"
      }
    }
  };
}

export function createControlPlaneApi(params: {
  store: ControlPlaneStore;
  artifacts: ArtifactStore;
  continuationRunner?: ContinuationRunner;
  identityResolver?: IdentityResolver;
  secretStore?: SecretStore;
  slackConnections?: SlackConnectionStore;
  slackOAuth?: SlackOAuthClient;
  usageMeter?: UsageMeter;
}): ControlPlaneApi {
  return {
    createApp: (request) => params.store.createApp(request),
    createTenant: (request) => createTenant(params.store, request),
    registerPlugin: (request) => registerPlugin(params.store, request),
    registerPluginVersion: (request) =>
      registerPluginVersion(params.store, params.artifacts, request),
    listPluginVersions: (request) => listPluginVersions(params.store, request),
    installPlugin: (request) => installPlugin(params.store, request),
    updateInstallationConfig: (request) => updateInstallationConfig(params.store, request),
    setInstallationEnabled: (request) => setInstallationEnabled(params.store, request),
    updateInstallationPriority: (request) => updateInstallationPriority(params.store, request),
    connectSlackWorkspace: (request) =>
      connectSlackWorkspace(params.store, request, {
        secretStore: params.secretStore,
        slackConnections: params.slackConnections,
        slackOAuth: params.slackOAuth
      }),
    rollbackInstallation: (request) => rollbackInstallation(params.store, request),
    decideApproval: (request) =>
      decideApproval(params.store, request, {
        continuationRunner: params.continuationRunner,
        identityResolver: params.identityResolver
      }),
    recordExecutionUsage: (request) =>
      requireUsageMeter(params.usageMeter).recordExecutionUsage(request),
    getDailyUsageSummary: (request) =>
      requireUsageMeter(params.usageMeter).getDailyUsageSummary(request),
    getDailyUsageSummaries: (request) =>
      requireUsageMeter(params.usageMeter).getDailyUsageSummaries(request)
  };
}

export function createStaticTokenIdentityResolver<TIdentity extends AuthenticatedIdentity>(
  identitiesByToken: Record<string, TIdentity>
): IdentityResolver {
  return {
    resolveToken: (token) => identitiesByToken[token] ?? null
  };
}

async function createTenant(
  store: ControlPlaneStore,
  request: CreateTenantRequest
): Promise<TenantRecord> {
  await requireApp(store, request.appId);
  return store.createTenant(request);
}

async function registerPlugin(
  store: ControlPlaneStore,
  request: RegisterPluginRequest
): Promise<PluginRecord> {
  await requireApp(store, request.appId);
  const existing = await store.findPluginByKey({ appId: request.appId, key: request.key });
  if (existing !== null) {
    return existing;
  }

  return store.createPlugin({
    id: pluginIdFor(request.appId, request.key),
    appId: request.appId,
    key: request.key
  });
}

async function registerPluginVersion(
  store: ControlPlaneStore,
  artifacts: ArtifactStore,
  request: RegisterPluginVersionRequest
): Promise<PluginVersionRecord> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  const manifest = parseVersionManifest(request.manifest, request.version);
  const existing = await store.findPluginVersion({
    pluginId: plugin.id,
    version: request.version
  });

  if (existing !== null) {
    throw apiError(
      409,
      "plugin_version_already_exists",
      `plugin version ${request.pluginKey}@${request.version} already exists`
    );
  }

  await artifacts.putArtifact(request.artifactHash, request.artifact);

  return store.createPluginVersion({
    id: pluginVersionIdFor(plugin.id, request.version),
    pluginId: plugin.id,
    version: request.version,
    artifactHash: request.artifactHash,
    manifest
  });
}

async function listPluginVersions(
  store: ControlPlaneStore,
  request: ListPluginVersionsRequest
): Promise<readonly PluginVersionRecord[]> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  return store.listPluginVersions({ pluginId: plugin.id });
}

async function installPlugin(
  store: ControlPlaneStore,
  request: InstallPluginRequest
): Promise<InstallationRecord> {
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  const version = await requirePluginVersion(store, plugin.id, request.version);
  await requireTenantInApp(store, request.tenantId, request.appId);
  const grants = validateInstallationGrants(version.manifest, request.config, request.grants);

  return store.createInstallation({
    id: request.id,
    tenantId: request.tenantId,
    pluginVersionId: version.id,
    enabled: request.enabled ?? true,
    priority: request.priority,
    config: grants.config,
    grants: grants.resolvedGrants
  });
}

async function updateInstallationConfig(
  store: ControlPlaneStore,
  request: UpdateInstallationConfigRequest
): Promise<InstallationRecord> {
  const installation = await requireInstallation(store, request.id);
  const version = await requirePluginVersionById(store, installation.pluginVersionId);
  const config = validateInstallationConfig(version.manifest, request.config);
  const grants = resolveRequiredGrants(version.manifest, config);

  return store.updateInstallationConfig({
    id: request.id,
    config,
    grants
  });
}

async function setInstallationEnabled(
  store: ControlPlaneStore,
  request: SetInstallationEnabledRequest
): Promise<InstallationRecord> {
  await requireInstallation(store, request.id);
  return store.setInstallationEnabled(request);
}

async function updateInstallationPriority(
  store: ControlPlaneStore,
  request: UpdateInstallationPriorityRequest
): Promise<InstallationRecord> {
  await requireInstallation(store, request.id);
  return store.updateInstallationPriority(request);
}

async function connectSlackWorkspace(
  store: ControlPlaneStore,
  request: ConnectSlackWorkspaceRequest,
  params: {
    secretStore: SecretStore | undefined;
    slackConnections: SlackConnectionStore | undefined;
    slackOAuth: SlackOAuthClient | undefined;
  }
): Promise<SlackConnectionRecord> {
  await requireTenantInApp(store, request.tenantId, request.appId);
  const secretStore = requireSlackSecretStore(params.secretStore);
  const slackConnections = requireSlackConnectionStore(params.slackConnections);
  const slackOAuth = requireSlackOAuthClient(params.slackOAuth);
  const token = await slackOAuth.exchangeCode({
    code: request.code,
    redirectUri: request.redirectUri
  });
  const secretRef = slackSecretRef({
    tenantId: request.tenantId,
    workspaceId: token.workspaceId
  });
  await secretStore.putSecret({
    ref: secretRef,
    value: token.accessToken
  });

  return slackConnections.upsertSlackConnection({
    id: slackConnectionId(request.tenantId, token.workspaceId),
    tenantId: request.tenantId,
    workspaceId: token.workspaceId,
    ...(token.workspaceName === undefined ? {} : { workspaceName: token.workspaceName }),
    ...(token.botUserId === undefined ? {} : { botUserId: token.botUserId }),
    secretRef,
    connectedAt: request.connectedAt ?? new Date()
  });
}

async function rollbackInstallation(
  store: ControlPlaneStore,
  request: RollbackInstallationRequest
): Promise<RollbackResult> {
  const installation = await requireInstallation(store, request.installationId);
  const currentVersion = await requirePluginVersionById(store, installation.pluginVersionId);
  const plugin = await requirePlugin(store, request.appId, request.pluginKey);
  if (currentVersion.pluginId !== plugin.id) {
    throw notFound("installation_not_found", "installation", request.installationId);
  }
  const targetVersion = await requirePluginVersion(store, plugin.id, request.targetVersion);
  const updated = await store.updateInstallationVersion({
    id: request.installationId,
    pluginVersionId: targetVersion.id
  });
  const audit = rollbackAuditRecord({
    request,
    installation,
    plugin,
    fromVersion: currentVersion.version
  });
  await store.writeExecution(audit);

  return { installation: updated, audit };
}

async function decideApproval(
  store: ControlPlaneStore,
  request: DecideApprovalRequest,
  params: {
    continuationRunner: ContinuationRunner | undefined;
    identityResolver: IdentityResolver | undefined;
  }
): Promise<ApprovalRecord> {
  const approval = await requireApproval(store, request.id, request.tenantId);
  await authorizeApprovalDecision(params.identityResolver, request, approval);
  const transition = resolveApprovalDecisionTransition(approval.state, request.decision);
  if (!transition.allowed) {
    throw apiError(
      409,
      "approval_already_decided",
      `approval ${request.id} is already ${approval.state}`
    );
  }

  const decidedAt = request.decidedAt ?? new Date();
  const updated = await store.decideApproval({
    id: request.id,
    decision: request.decision,
    decidedBy: request.actor,
    ...(request.reason === undefined ? {} : { decisionReason: request.reason }),
    decidedAt
  });
  await store.writeExecution(approvalDecisionAuditRecord({ request, approval, decidedAt }));
  if (params.continuationRunner !== undefined) {
    await store.writeExecution(
      await params.continuationRunner.runApprovalContinuation({
        approval,
        payload: approvalDecisionPayload({ request, approval }),
        decidedAt
      })
    );
  }

  return updated;
}

async function requirePlugin(
  store: ControlPlaneStore,
  appId: string,
  key: string
): Promise<PluginRecord> {
  const plugin = await store.findPluginByKey({ appId, key });
  if (plugin === null) {
    throw notFound("plugin_not_found", "plugin", key);
  }

  return plugin;
}

async function requireApp(store: ControlPlaneStore, appId: string): Promise<AppRecord> {
  const app = await store.findAppById(appId);
  if (app === null) {
    throw notFound("app_not_found", "app", appId);
  }

  return app;
}

async function requireTenantInApp(
  store: ControlPlaneStore,
  tenantId: string,
  appId: string
): Promise<TenantRecord> {
  const tenant = await store.findTenantById(tenantId);
  if (tenant === null || tenant.appId !== appId) {
    throw notFound("tenant_not_found", "tenant", tenantId);
  }

  return tenant;
}

async function requirePluginVersion(
  store: ControlPlaneStore,
  pluginId: string,
  version: string
): Promise<PluginVersionRecord> {
  const pluginVersion = await store.findPluginVersion({ pluginId, version });
  if (pluginVersion === null) {
    throw notFound("plugin_version_not_found", "plugin version", version);
  }

  return pluginVersion;
}

async function requirePluginVersionById(
  store: ControlPlaneStore,
  pluginVersionId: string
): Promise<PluginVersionRecord> {
  const pluginVersion = await store.findPluginVersionById(pluginVersionId);
  if (pluginVersion === null) {
    throw notFound("plugin_version_not_found", "plugin version", pluginVersionId);
  }

  return pluginVersion;
}

async function requireInstallation(
  store: ControlPlaneStore,
  id: string
): Promise<InstallationRecord> {
  const installation = await store.findInstallationById(id);
  if (installation === null) {
    throw notFound("installation_not_found", "installation", id);
  }

  return installation;
}

async function requireApproval(
  store: ControlPlaneStore,
  id: string,
  tenantId: string
): Promise<ApprovalRecord> {
  const approval = await store.findApprovalById(id);
  if (approval === null || approval.tenantId !== tenantId) {
    throw notFound("approval_not_found", "approval", id);
  }

  return approval;
}

function parseVersionManifest(input: unknown, version: string): TenantScriptManifest {
  const parsed = parseManifest(input);
  if (!parsed.ok) {
    throw badRequest("invalid_manifest", "manifest validation failed");
  }

  if (parsed.value.version !== version) {
    throw badRequest(
      "version_mismatch",
      `manifest version ${parsed.value.version} does not match ${version}`
    );
  }

  return parsed.value;
}

function validateInstallationGrants(
  manifest: TenantScriptManifest,
  configInput: Record<string, unknown>,
  grantInput: Record<string, unknown>
): { config: InstallationConfig; resolvedGrants: GrantMap } {
  const config = validateInstallationConfig(manifest, configInput);
  const resolvedGrants = resolveRequiredGrants(manifest, config);
  if (!deepEqual(resolvedGrants, grantInput)) {
    throw badRequest(
      "invalid_grants",
      "installation grants do not match manifest capability requirements"
    );
  }

  return { config, resolvedGrants };
}

function validateInstallationConfig(
  manifest: TenantScriptManifest,
  configInput: Record<string, unknown>
): InstallationConfig {
  const config = validateConfig(manifest.configSchema, configInput);
  if (!config.ok) {
    throw badRequest("invalid_config", "installation config validation failed");
  }

  return config.value;
}

function resolveRequiredGrants(
  manifest: TenantScriptManifest,
  config: InstallationConfig
): GrantMap {
  const grants = resolveGrants(manifest.capabilities, config);
  if (!grants.ok) {
    throw badRequest("invalid_grants", "manifest capability grants are invalid");
  }

  return grants.value;
}

function badRequest(code: string, message: string): ControlPlaneApiError {
  return apiError(400, code, message);
}

function notFound(code: string, resource: string, id: string): ControlPlaneApiError {
  return apiError(404, code, `${resource} ${id} was not found`);
}

function apiError(
  status: Exclude<ControlPlaneErrorStatus, 500>,
  code: string,
  message: string
): ControlPlaneApiError {
  return new ControlPlaneApiError(status, code, message);
}

function requireSlackSecretStore(secretStore: SecretStore | undefined): SecretStore {
  if (secretStore === undefined) {
    throw new Error("Slack OAuth secret store is not configured");
  }
  return secretStore;
}

function requireSlackConnectionStore(
  slackConnections: SlackConnectionStore | undefined
): SlackConnectionStore {
  if (slackConnections === undefined) {
    throw new Error("Slack connection store is not configured");
  }
  return slackConnections;
}

function requireSlackOAuthClient(slackOAuth: SlackOAuthClient | undefined): SlackOAuthClient {
  if (slackOAuth === undefined) {
    throw new Error("Slack OAuth client is not configured");
  }
  return slackOAuth;
}

function requireUsageMeter(usageMeter: UsageMeter | undefined): UsageMeter {
  if (usageMeter === undefined) {
    throw new Error("usage meter is not configured");
  }
  return usageMeter;
}

function slackSecretRef(params: { tenantId: string; workspaceId: string }): SecretRef {
  return {
    provider: "slack",
    tenantId: params.tenantId,
    secretId: `slack:${params.workspaceId}`
  };
}

function slackConnectionId(tenantId: string, workspaceId: string): string {
  return stableId("slack", tenantId, workspaceId);
}

async function authorizeApprovalDecision(
  identityResolver: IdentityResolver | undefined,
  request: DecideApprovalRequest,
  approval: ApprovalRecord
): Promise<void> {
  if (identityResolver === undefined) {
    return;
  }

  const token = request.authToken;
  const identity = token === undefined ? null : await identityResolver.resolveToken(token);
  // request.role remains ignored so callers cannot self-assert privileges. Existing manager
  // approvals use the central RBAC matrix; future explicit requirements remain exact.
  if (
    identity === null ||
    !canRolePerform(identity.role, "approval:decide") ||
    (approval.role !== "manager" &&
      normalizeRbacRole(identity.role) !== normalizeRbacRole(approval.role))
  ) {
    throw apiError(
      403,
      "approval_role_forbidden",
      `approval ${approval.id} requires role ${approval.role}`
    );
  }
}

function rollbackAuditRecord(params: {
  request: RollbackInstallationRequest;
  installation: InstallationRecord;
  plugin: PluginRecord;
  fromVersion: string;
}): RollbackAuditRecord {
  return {
    id: params.request.auditId,
    tenantId: params.installation.tenantId,
    pluginId: params.plugin.id,
    hookName: "installation.rollback",
    version: params.request.targetVersion,
    status: "success",
    durationMs: 0,
    error: rollbackAuditMessage(params.request, params.fromVersion),
    capabilityCalls: [{ name: "rollback", status: "success" }],
    createdAt: params.request.createdAt ?? new Date()
  };
}

function rollbackAuditMessage(request: RollbackInstallationRequest, fromVersion: string): string {
  const reason = request.reason === undefined ? "" : `: ${request.reason}`;
  return `rolled back from ${fromVersion} by ${request.actor}${reason}`;
}

function approvalDecisionAuditRecord(params: {
  request: DecideApprovalRequest;
  approval: ApprovalRecord;
  decidedAt: Date;
}): ControlPlaneExecutionRecord {
  return {
    id: params.request.auditId,
    tenantId: params.approval.tenantId,
    pluginId: params.approval.pluginId,
    hookName: "approval.decision",
    version: "",
    status: "success",
    durationMs: 0,
    error: approvalDecisionAuditMessage(params.request),
    capabilityCalls: [{ name: "approvals.decide", status: "success" }],
    createdAt: params.decidedAt
  };
}

function approvalDecisionAuditMessage(request: DecideApprovalRequest): string {
  const reason = request.reason === undefined ? "" : `: ${request.reason}`;
  return `${request.decision} by ${request.actor}${reason}`;
}

function approvalDecisionPayload(params: {
  request: DecideApprovalRequest;
  approval: ApprovalRecord;
}): ApprovalDecisionPayload {
  return {
    approvalId: params.approval.id,
    decision: params.request.decision,
    subject: params.approval.subject,
    decidedBy: params.request.actor,
    ...(params.request.reason === undefined ? {} : { reason: params.request.reason })
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginIdFor(appId: string, key: string): string {
  return stableId("plugin", appId, key);
}

function pluginVersionIdFor(pluginId: string, version: string): string {
  return stableId("plugin-version", pluginId, version);
}

function stableId(...parts: readonly string[]): string {
  return parts.map(escapeStableIdPart).join(":");
}

function escapeStableIdPart(part: string): string {
  return part.replaceAll("%", "%25").replaceAll(":", "%3A");
}
