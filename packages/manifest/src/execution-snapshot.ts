import { valid } from "semver";
import type { FailurePolicy, HookType } from "./contracts.js";
import { isAllowedFailurePolicy, isHookType, isValidHookConfiguration } from "./contracts.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const artifactDigestPattern = /^[a-f0-9]{64}$/u;
const snapshotDigestPattern = /^sha256:[a-f0-9]{64}$/u;
const destinationUriSchemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_LIMIT_VALUE = 2_147_483_647;
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_SNAPSHOT_BYTES = 131_072;
const MAX_GRANTS = 256;
const MAX_RECORD_KEYS = 32;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const forbiddenJsonKeys = new Set(["__proto__", "constructor", "prototype"]);

interface SubtleCryptoLike {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

interface GlobalCryptoLike {
  crypto?: {
    subtle: SubtleCryptoLike;
  };
}

export const executionSnapshotErrorCodes = [
  "snapshot_input_invalid",
  "snapshot_identity_invalid",
  "snapshot_hook_invalid",
  "snapshot_release_invalid",
  "snapshot_grant_invalid",
  "snapshot_limit_invalid",
  "snapshot_destination_invalid",
  "snapshot_serialization_failed",
  "snapshot_integrity_failed"
] as const;

export type ExecutionSnapshotErrorCode = (typeof executionSnapshotErrorCodes)[number];

export class ExecutionSnapshotError extends Error {
  override readonly name = "ExecutionSnapshotError";

  constructor(readonly code: ExecutionSnapshotErrorCode) {
    super(code);
  }

  toJSON(): { code: ExecutionSnapshotErrorCode } {
    return { code: this.code };
  }
}

export const executionSnapshotRuntimeClasses = ["inline"] as const;
export type ExecutionSnapshotRuntimeClass = (typeof executionSnapshotRuntimeClasses)[number];

export interface ValidatedHookContract {
  name: string;
  type: HookType;
  failurePolicy: FailurePolicy;
}

export interface ValidatedPluginRelease {
  id: string;
  version: string;
  artifactSha256: string;
  runtimeClass: ExecutionSnapshotRuntimeClass;
}

export interface ValidatedRuntimeLimits {
  timeoutMs: number;
  memoryMb: number;
  maxSubrequests: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface CompileExecutionSnapshotInputV1 {
  appId: string;
  tenantId: string;
  installationId: string;
  hook: ValidatedHookContract;
  pluginRelease: ValidatedPluginRelease;
  grants: readonly string[];
  configCanonicalBytes: Uint8Array;
  limits: ValidatedRuntimeLimits;
  destinationReferenceId?: string;
  sourceRevision: number;
  publishedAt: Date;
}

export interface ExecutionSnapshotPluginV1 {
  readonly pluginId: string;
  readonly version: string;
  readonly artifactSha256: string;
  readonly runtimeClass: ExecutionSnapshotRuntimeClass;
}

export interface ExecutionSnapshotDestinationV1 {
  readonly kind: "installation-webhook";
  readonly referenceId: string;
}

export interface ExecutionSnapshotV1 {
  readonly schemaVersion: "1";
  readonly snapshotId: string;
  readonly appId: string;
  readonly tenantId: string;
  readonly installationId: string;
  readonly hook: Readonly<ValidatedHookContract>;
  readonly plugin: Readonly<ExecutionSnapshotPluginV1>;
  readonly grants: readonly string[];
  readonly configSha256: string;
  readonly limits: Readonly<ValidatedRuntimeLimits>;
  readonly destination?: ExecutionSnapshotDestinationV1;
  readonly publishedAt: string;
  readonly sourceRevision: number;
}

export interface CompiledExecutionSnapshotV1 {
  readonly snapshot: ExecutionSnapshotV1;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

interface SnapshotPayloadV1 {
  schemaVersion: "1";
  appId: string;
  tenantId: string;
  installationId: string;
  hook: ValidatedHookContract;
  plugin: ExecutionSnapshotPluginV1;
  grants: string[];
  configSha256: string;
  limits: ValidatedRuntimeLimits;
  destination?: ExecutionSnapshotDestinationV1;
  publishedAt: string;
  sourceRevision: number;
}

export async function compileExecutionSnapshotV1(
  input: CompileExecutionSnapshotInputV1
): Promise<CompiledExecutionSnapshotV1> {
  let normalized: NormalizedInput;
  try {
    normalized = normalizeInput(input);
  } catch (error) {
    throw preserveSnapshotError(error, "snapshot_input_invalid");
  }

  try {
    const payload: SnapshotPayloadV1 = {
      schemaVersion: "1",
      appId: normalized.appId,
      tenantId: normalized.tenantId,
      installationId: normalized.installationId,
      hook: normalized.hook,
      plugin: normalized.plugin,
      grants: normalized.grants,
      configSha256: await sha256(normalized.configCanonicalBytes),
      limits: normalized.limits,
      ...(normalized.destination === undefined ? {} : { destination: normalized.destination }),
      publishedAt: normalized.publishedAt,
      sourceRevision: normalized.sourceRevision
    };
    const digest = `sha256:${await sha256(encodeSnapshotPayload(payload))}`;
    const snapshot = deepFreeze({
      schemaVersion: payload.schemaVersion,
      snapshotId: digest,
      appId: payload.appId,
      tenantId: payload.tenantId,
      installationId: payload.installationId,
      hook: payload.hook,
      plugin: payload.plugin,
      grants: payload.grants,
      configSha256: payload.configSha256,
      limits: payload.limits,
      ...(payload.destination === undefined ? {} : { destination: payload.destination }),
      publishedAt: payload.publishedAt,
      sourceRevision: payload.sourceRevision
    });
    const canonicalBytes = encodeText(serializeSnapshot(snapshot));
    if (canonicalBytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new ExecutionSnapshotError("snapshot_serialization_failed");
    }
    return Object.freeze({
      snapshot,
      get bytes(): Uint8Array {
        return new Uint8Array(canonicalBytes);
      },
      digest
    });
  } catch (error) {
    throw preserveSnapshotError(error, "snapshot_serialization_failed");
  }
}

export async function parseExecutionSnapshotV1(bytes: Uint8Array): Promise<ExecutionSnapshotV1> {
  let source: string;
  try {
    source = decodeText(copyByteArray(bytes, MAX_SNAPSHOT_BYTES, "snapshot_serialization_failed"));
  } catch (error) {
    throw preserveSnapshotError(error, "snapshot_serialization_failed");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }

  let snapshot: ExecutionSnapshotV1;
  try {
    snapshot = normalizeParsedSnapshot(parsed);
    if (serializeSnapshot(snapshot) !== source) {
      throw new ExecutionSnapshotError("snapshot_serialization_failed");
    }
  } catch (error) {
    throw preserveSnapshotError(error, "snapshot_serialization_failed");
  }

  try {
    const expectedDigest = `sha256:${await sha256(encodeSnapshotPayload(snapshotPayload(snapshot)))}`;
    if (expectedDigest !== snapshot.snapshotId) {
      throw new ExecutionSnapshotError("snapshot_integrity_failed");
    }
    return snapshot;
  } catch (error) {
    throw preserveSnapshotError(error, "snapshot_integrity_failed");
  }
}

interface NormalizedInput {
  appId: string;
  tenantId: string;
  installationId: string;
  hook: ValidatedHookContract;
  plugin: ExecutionSnapshotPluginV1;
  grants: string[];
  configCanonicalBytes: Uint8Array;
  limits: ValidatedRuntimeLimits;
  destination: ExecutionSnapshotDestinationV1 | undefined;
  sourceRevision: number;
  publishedAt: string;
}

function normalizeInput(input: unknown): NormalizedInput {
  const record = exactRecord(
    input,
    [
      "appId",
      "tenantId",
      "installationId",
      "hook",
      "pluginRelease",
      "grants",
      "configCanonicalBytes",
      "limits",
      "sourceRevision",
      "publishedAt"
    ],
    ["destinationReferenceId"],
    "snapshot_input_invalid"
  );

  return {
    appId: identifier(record.appId, "snapshot_identity_invalid"),
    tenantId: identifier(record.tenantId, "snapshot_identity_invalid"),
    installationId: identifier(record.installationId, "snapshot_identity_invalid"),
    hook: normalizeHook(record.hook),
    plugin: normalizePluginRelease(record.pluginRelease),
    grants: normalizeGrants(record.grants, false),
    configCanonicalBytes: normalizeConfigBytes(record.configCanonicalBytes),
    limits: normalizeLimits(record.limits),
    destination: normalizeInputDestination(record),
    sourceRevision: safeRevision(record.sourceRevision),
    publishedAt: normalizePublishedDate(record.publishedAt)
  };
}

function normalizeParsedSnapshot(input: unknown): ExecutionSnapshotV1 {
  const record = exactRecord(
    input,
    [
      "schemaVersion",
      "snapshotId",
      "appId",
      "tenantId",
      "installationId",
      "hook",
      "plugin",
      "grants",
      "configSha256",
      "limits",
      "publishedAt",
      "sourceRevision"
    ],
    ["destination"],
    "snapshot_serialization_failed"
  );
  if (record.schemaVersion !== "1" || !isSnapshotDigest(record.snapshotId)) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }

  const destination = normalizeParsedDestination(record.destination);
  const snapshot = {
    schemaVersion: "1" as const,
    snapshotId: record.snapshotId,
    appId: identifier(record.appId, "snapshot_serialization_failed"),
    tenantId: identifier(record.tenantId, "snapshot_serialization_failed"),
    installationId: identifier(record.installationId, "snapshot_serialization_failed"),
    hook: normalizeHook(record.hook, "snapshot_serialization_failed"),
    plugin: normalizeParsedPlugin(record.plugin),
    grants: normalizeGrants(record.grants, true, "snapshot_serialization_failed"),
    configSha256: digestValue(record.configSha256, "snapshot_serialization_failed"),
    limits: normalizeLimits(record.limits, "snapshot_serialization_failed"),
    ...(destination === undefined ? {} : { destination }),
    publishedAt: timestampValue(record.publishedAt, "snapshot_serialization_failed"),
    sourceRevision: safeRevision(record.sourceRevision, "snapshot_serialization_failed")
  };
  return deepFreeze(snapshot);
}

function normalizeHook(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_hook_invalid"
): ValidatedHookContract {
  const record = exactRecord(value, ["name", "type", "failurePolicy"], [], errorCode);
  const name = record.name;
  const type = record.type;
  const failurePolicy = record.failurePolicy;
  if (
    !isHookName(name) ||
    !isHookType(type) ||
    !isFailurePolicy(failurePolicy) ||
    !isAllowedFailurePolicy(type, failurePolicy) ||
    !isValidHookConfiguration(name, type, failurePolicy)
  ) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return { name, type, failurePolicy };
}

function normalizePluginRelease(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_release_invalid"
): ExecutionSnapshotPluginV1 {
  const record = exactRecord(
    value,
    ["id", "version", "artifactSha256", "runtimeClass"],
    [],
    errorCode
  );
  if (
    !isIdentifier(record.id) ||
    !isPluginVersion(record.version) ||
    !isArtifactDigest(record.artifactSha256) ||
    !isRuntimeClass(record.runtimeClass)
  ) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return {
    pluginId: record.id,
    version: record.version,
    artifactSha256: record.artifactSha256,
    runtimeClass: record.runtimeClass
  };
}

function normalizeParsedPlugin(value: unknown): ExecutionSnapshotPluginV1 {
  const record = exactRecord(
    value,
    ["pluginId", "version", "artifactSha256", "runtimeClass"],
    [],
    "snapshot_serialization_failed"
  );
  if (
    !isIdentifier(record.pluginId) ||
    !isPluginVersion(record.version) ||
    !isArtifactDigest(record.artifactSha256) ||
    !isRuntimeClass(record.runtimeClass)
  ) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  return {
    pluginId: record.pluginId,
    version: record.version,
    artifactSha256: record.artifactSha256,
    runtimeClass: record.runtimeClass
  };
}

function normalizeGrants(
  value: unknown,
  requireSorted: boolean,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_grant_invalid"
): string[] {
  const values = exactArray(value, errorCode, MAX_GRANTS);
  const grants = values.map((entry) => {
    if (!isIdentifier(entry)) throw new ExecutionSnapshotError(errorCode);
    return entry;
  });
  if (new Set(grants).size !== grants.length) throw new ExecutionSnapshotError(errorCode);
  const sorted = [...grants].sort(compareCodeUnits);
  if (requireSorted && !arraysEqual(grants, sorted)) throw new ExecutionSnapshotError(errorCode);
  return sorted;
}

function normalizeConfigBytes(value: unknown): Uint8Array {
  const bytes = copyByteArray(value, MAX_CONFIG_BYTES, "snapshot_serialization_failed");
  let source: string;
  try {
    source = decodeText(bytes);
  } catch {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  if (!isPlainRecord(parsed)) throw new ExecutionSnapshotError("snapshot_serialization_failed");
  if (canonicalJsonValue(parsed) !== source) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  return bytes;
}

function normalizeLimits(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_limit_invalid"
): ValidatedRuntimeLimits {
  const record = exactRecord(
    value,
    ["timeoutMs", "memoryMb", "maxSubrequests", "maxInputBytes", "maxOutputBytes"],
    [],
    errorCode
  );
  if (
    !isBoundedInteger(record.timeoutMs, 1) ||
    !isBoundedInteger(record.memoryMb, 8) ||
    !isBoundedInteger(record.maxSubrequests, 0) ||
    !isBoundedInteger(record.maxInputBytes, 0) ||
    !isBoundedInteger(record.maxOutputBytes, 0)
  ) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return {
    timeoutMs: record.timeoutMs,
    memoryMb: record.memoryMb,
    maxSubrequests: record.maxSubrequests,
    maxInputBytes: record.maxInputBytes,
    maxOutputBytes: record.maxOutputBytes
  };
}

function normalizeInputDestination(
  record: Record<string, unknown>
): ExecutionSnapshotDestinationV1 | undefined {
  if (!Object.hasOwn(record, "destinationReferenceId")) return undefined;
  const referenceId = destinationReference(record.destinationReferenceId);
  return { kind: "installation-webhook", referenceId };
}

function normalizeParsedDestination(value: unknown): ExecutionSnapshotDestinationV1 | undefined {
  if (value === undefined) return undefined;
  const record = exactRecord(value, ["kind", "referenceId"], [], "snapshot_serialization_failed");
  if (record.kind !== "installation-webhook") {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  return {
    kind: "installation-webhook",
    referenceId: destinationReference(record.referenceId, "snapshot_serialization_failed")
  };
}

function snapshotPayload(snapshot: ExecutionSnapshotV1): SnapshotPayloadV1 {
  return {
    schemaVersion: "1",
    appId: snapshot.appId,
    tenantId: snapshot.tenantId,
    installationId: snapshot.installationId,
    hook: { ...snapshot.hook },
    plugin: { ...snapshot.plugin },
    grants: [...snapshot.grants],
    configSha256: snapshot.configSha256,
    limits: { ...snapshot.limits },
    ...(snapshot.destination === undefined ? {} : { destination: { ...snapshot.destination } }),
    publishedAt: snapshot.publishedAt,
    sourceRevision: snapshot.sourceRevision
  };
}

function encodeSnapshotPayload(payload: SnapshotPayloadV1): Uint8Array {
  return encodeText(serializePayload(payload));
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeText(value: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
}

function serializeSnapshot(snapshot: ExecutionSnapshotV1): string {
  return serializePayload({
    ...snapshotPayload(snapshot),
    snapshotId: snapshot.snapshotId
  });
}

function serializePayload(payload: SnapshotPayloadV1 & { snapshotId?: string }): string {
  const fields = [
    `"schemaVersion":${JSON.stringify(payload.schemaVersion)}`,
    ...(payload.snapshotId === undefined
      ? []
      : [`"snapshotId":${JSON.stringify(payload.snapshotId)}`]),
    `"appId":${JSON.stringify(payload.appId)}`,
    `"tenantId":${JSON.stringify(payload.tenantId)}`,
    `"installationId":${JSON.stringify(payload.installationId)}`,
    `"hook":{"name":${JSON.stringify(payload.hook.name)},"type":${JSON.stringify(payload.hook.type)},"failurePolicy":${JSON.stringify(payload.hook.failurePolicy)}}`,
    `"plugin":{"pluginId":${JSON.stringify(payload.plugin.pluginId)},"version":${JSON.stringify(payload.plugin.version)},"artifactSha256":${JSON.stringify(payload.plugin.artifactSha256)},"runtimeClass":${JSON.stringify(payload.plugin.runtimeClass)}}`,
    `"grants":${JSON.stringify(payload.grants)}`,
    `"configSha256":${JSON.stringify(payload.configSha256)}`,
    `"limits":{"timeoutMs":${String(payload.limits.timeoutMs)},"memoryMb":${String(payload.limits.memoryMb)},"maxSubrequests":${String(payload.limits.maxSubrequests)},"maxInputBytes":${String(payload.limits.maxInputBytes)},"maxOutputBytes":${String(payload.limits.maxOutputBytes)}}`,
    ...(payload.destination === undefined
      ? []
      : [
          `"destination":{"kind":${JSON.stringify(payload.destination.kind)},"referenceId":${JSON.stringify(payload.destination.referenceId)}}`
        ]),
    `"publishedAt":${JSON.stringify(payload.publishedAt)}`,
    `"sourceRevision":${String(payload.sourceRevision)}`
  ];
  return `{${fields.join(",")}}`;
}

function exactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errorCode: ExecutionSnapshotErrorCode
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new ExecutionSnapshotError(errorCode);
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0 || names.length > MAX_RECORD_KEYS || names.length < requiredKeys.length) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (requiredKeys.some((key) => !names.includes(key)) || names.some((key) => !allowed.has(key))) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ExecutionSnapshotError(errorCode);
    }
    result[name] = descriptor.value;
  }
  return result;
}

function exactArray(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode,
  maximumLength = MAX_JSON_NODES
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ExecutionSnapshotError(errorCode);
  }
  let length: number;
  try {
    length = value.length;
  } catch {
    throw new ExecutionSnapshotError(errorCode);
  }
  if (!Number.isSafeInteger(length) || length > maximumLength) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0 || names.length !== length + 1 || !names.includes("length")) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const name = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ExecutionSnapshotError(errorCode);
    }
    result.push(descriptor.value);
  }
  return result;
}

function copyByteArray(
  value: unknown,
  maximumBytes: number,
  errorCode: ExecutionSnapshotErrorCode
): Uint8Array {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype) {
    throw new ExecutionSnapshotError(errorCode);
  }
  let byteLength: number;
  try {
    byteLength = value.byteLength;
  } catch {
    throw new ExecutionSnapshotError(errorCode);
  }
  if (byteLength === 0 || byteLength > maximumBytes) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0 || names.length !== byteLength) {
    throw new ExecutionSnapshotError(errorCode);
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new ExecutionSnapshotError(errorCode);
    }
  }
  try {
    return Uint8Array.prototype.slice.call(value);
  } catch {
    throw new ExecutionSnapshotError(errorCode);
  }
}

function canonicalJsonValue(
  value: unknown,
  depth = 0,
  state = { nodes: 0 },
  ancestors = new Set<object>()
): string {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new ExecutionSnapshotError("snapshot_serialization_failed");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new ExecutionSnapshotError("snapshot_serialization_failed");
  if (ancestors.has(value)) throw new ExecutionSnapshotError("snapshot_serialization_failed");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = exactArray(value, "snapshot_serialization_failed");
      return `[${entries
        .map((entry) => canonicalJsonValue(entry, depth + 1, state, ancestors))
        .join(",")}]`;
    }
    if (!isPlainRecord(value)) throw new ExecutionSnapshotError("snapshot_serialization_failed");
    const names = Object.getOwnPropertyNames(value);
    if (names.length > MAX_JSON_NODES || Object.getOwnPropertySymbols(value).length > 0) {
      throw new ExecutionSnapshotError("snapshot_serialization_failed");
    }
    const fields = names.sort(compareCodeUnits).map((name) => {
      if (forbiddenJsonKeys.has(name)) {
        throw new ExecutionSnapshotError("snapshot_serialization_failed");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new ExecutionSnapshotError("snapshot_serialization_failed");
      }
      return `${JSON.stringify(name)}:${canonicalJsonValue(descriptor.value, depth + 1, state, ancestors)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value: unknown, errorCode: ExecutionSnapshotErrorCode): string {
  if (!isIdentifier(value)) throw new ExecutionSnapshotError(errorCode);
  return value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function isHookName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= 256 &&
    !hasControlCharacter(value)
  );
}

function isFailurePolicy(value: unknown): value is FailurePolicy {
  return value === "fail-closed" || value === "use-original" || value === "record-only";
}

function isPluginVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && valid(value) === value;
}

function isRuntimeClass(value: unknown): value is ExecutionSnapshotRuntimeClass {
  return value === "inline";
}

function isArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && artifactDigestPattern.test(value);
}

function isSnapshotDigest(value: unknown): value is string {
  return typeof value === "string" && snapshotDigestPattern.test(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isBoundedInteger(value: unknown, minimum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= MAX_LIMIT_VALUE &&
    !Object.is(value, -0)
  );
}

function safeRevision(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_input_invalid"
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return value;
}

function normalizePublishedDate(value: unknown): string {
  if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  if (
    Object.getOwnPropertyNames(value).length > 0 ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  let timestamp: string;
  try {
    timestamp = Date.prototype.toISOString.call(value);
  } catch {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  if (!timestampPattern.test(timestamp)) {
    throw new ExecutionSnapshotError("snapshot_serialization_failed");
  }
  return timestamp;
}

function timestampValue(value: unknown, errorCode: ExecutionSnapshotErrorCode): string {
  if (typeof value !== "string" || !timestampPattern.test(value)) {
    throw new ExecutionSnapshotError(errorCode);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || Date.prototype.toISOString.call(date) !== value) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return value;
}

function digestValue(value: unknown, errorCode: ExecutionSnapshotErrorCode): string {
  if (!isArtifactDigest(value)) throw new ExecutionSnapshotError(errorCode);
  return value;
}

function destinationReference(
  value: unknown,
  errorCode: ExecutionSnapshotErrorCode = "snapshot_destination_invalid"
): string {
  if (!isIdentifier(value) || destinationUriSchemePattern.test(value)) {
    throw new ExecutionSnapshotError(errorCode);
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const runtime = globalThis as unknown as GlobalCryptoLike;
  const subtle = runtime.crypto?.subtle;
  if (subtle === undefined) throw new Error("crypto_unavailable");
  const digest = await subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function preserveSnapshotError(
  error: unknown,
  fallback: ExecutionSnapshotErrorCode
): ExecutionSnapshotError {
  return error instanceof ExecutionSnapshotError ? error : new ExecutionSnapshotError(fallback);
}
