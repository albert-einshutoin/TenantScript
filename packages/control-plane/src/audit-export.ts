import type { ExecutionRecord } from "./index.js";
import type { ExecutionArchiveSearchQuery } from "./execution-archive.js";

const EXPORT_SCHEMA_VERSION = 1 as const;
const SIGNATURE_ALGORITHM = "HMAC-SHA-256" as const;
const MINIMUM_SIGNING_KEY_BYTES = 32;

export interface AuditExportRequest {
  appId: string;
  tenantId: string;
  from: Date;
  to: Date;
}

export interface AuditExportManifest {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  appId: string;
  tenantId: string;
  from: string;
  to: string;
  generatedAt: string;
  eventCount: number;
  contentHash: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  signingKeyId: string;
  signature: string;
}

export interface AuditExportResult {
  ndjson: string;
  manifest: AuditExportManifest;
}

export interface AuditExportService {
  exportPeriod: (request: AuditExportRequest) => Promise<AuditExportResult>;
}

export interface AuditExportServiceOptions {
  search: (query: ExecutionArchiveSearchQuery) => Promise<readonly ExecutionRecord[]>;
  signingKey: string;
  signingKeyId: string;
  now?: () => Date;
}

interface ExportedExecution {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  id: string;
  tenantId: string;
  pluginId: string;
  hookName: string;
  version: string;
  status: ExecutionRecord["status"];
  durationMs: number;
  errorPresent: boolean;
  capabilityCalls: ExecutionRecord["capabilityCalls"];
  createdAt: string;
}

type UnsignedManifest = Omit<AuditExportManifest, "signature">;

export function createAuditExportService(options: AuditExportServiceOptions): AuditExportService {
  const signingKeyBytes = validateSigningKey(options.signingKey);
  if (options.signingKeyId.trim().length === 0) {
    throw new TypeError("audit export signing key id must not be empty");
  }
  const now = options.now ?? (() => new Date());

  return {
    exportPeriod: async (request) => {
      validateRequest(request);
      const generatedAt = now();
      validateDate(generatedAt, "generatedAt");
      const records = [...(await options.search(request))].sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      );
      for (const record of records) {
        if (
          record.tenantId !== request.tenantId ||
          record.createdAt < request.from ||
          record.createdAt > request.to
        ) {
          throw new Error("audit export search returned out-of-scope evidence");
        }
      }

      const ndjson = serializeRecords(records);
      const unsigned: UnsignedManifest = {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        appId: request.appId,
        tenantId: request.tenantId,
        from: request.from.toISOString(),
        to: request.to.toISOString(),
        generatedAt: generatedAt.toISOString(),
        eventCount: records.length,
        contentHash: await sha256(ndjson),
        signatureAlgorithm: SIGNATURE_ALGORITHM,
        signingKeyId: options.signingKeyId
      };
      const signature = await signManifest(unsigned, signingKeyBytes);
      return { ndjson, manifest: { ...unsigned, signature } };
    }
  };
}

export async function verifyAuditExport(
  result: AuditExportResult,
  signingKey: string
): Promise<boolean> {
  const keyBytes = validateSigningKey(signingKey);
  if (!isManifestShape(result.manifest)) return false;
  if ((await sha256(result.ndjson)) !== result.manifest.contentHash) return false;
  if (countNdjsonRecords(result.ndjson) !== result.manifest.eventCount) return false;
  const { signature, ...unsigned } = result.manifest;
  const signatureBytes = hexToBytes(signature);
  if (signatureBytes === null) return false;
  const key = await importSigningKey(keyBytes, ["verify"]);
  return crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signatureBytes),
    new TextEncoder().encode(serializeManifest(unsigned))
  );
}

function serializeRecords(records: readonly ExecutionRecord[]): string {
  if (records.length === 0) return "";
  return `${records
    .map((record) =>
      JSON.stringify({
        schemaVersion: EXPORT_SCHEMA_VERSION,
        id: record.id,
        tenantId: record.tenantId,
        pluginId: record.pluginId,
        hookName: record.hookName,
        version: record.version,
        status: record.status,
        durationMs: record.durationMs,
        errorPresent: record.error !== undefined,
        capabilityCalls: record.capabilityCalls.map((call) => ({
          name: call.name,
          status: call.status
        })),
        createdAt: record.createdAt.toISOString()
      } satisfies ExportedExecution)
    )
    .join("\n")}\n`;
}

async function signManifest(manifest: UnsignedManifest, keyBytes: Uint8Array): Promise<string> {
  const key = await importSigningKey(keyBytes, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(serializeManifest(manifest))
  );
  return bytesToHex(new Uint8Array(signature));
}

function serializeManifest(manifest: UnsignedManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    appId: manifest.appId,
    tenantId: manifest.tenantId,
    from: manifest.from,
    to: manifest.to,
    generatedAt: manifest.generatedAt,
    eventCount: manifest.eventCount,
    contentHash: manifest.contentHash,
    signatureAlgorithm: manifest.signatureAlgorithm,
    signingKeyId: manifest.signingKeyId
  } satisfies UnsignedManifest);
}

async function importSigningKey(
  keyBytes: Uint8Array,
  usages: ("sign" | "verify")[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function countNdjsonRecords(content: string): number {
  return content.split("\n").filter((line) => line.length > 0).length;
}

function validateSigningKey(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < MINIMUM_SIGNING_KEY_BYTES) {
    throw new TypeError("audit export signing key must be at least 32 bytes");
  }
  return bytes;
}

function validateRequest(request: AuditExportRequest): void {
  if (request.appId.trim().length === 0 || request.tenantId.trim().length === 0) {
    throw new TypeError("audit export scope must not be empty");
  }
  validateDate(request.from, "from");
  validateDate(request.to, "to");
  if (request.from > request.to) throw new TypeError("audit export range is invalid");
}

function validateDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid date`);
}

function isManifestShape(value: unknown): value is AuditExportManifest {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === EXPORT_SCHEMA_VERSION &&
    value.signatureAlgorithm === SIGNATURE_ALGORITHM &&
    typeof value.signingKeyId === "string" &&
    value.signingKeyId.length > 0 &&
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    typeof value.tenantId === "string" &&
    value.tenantId.length > 0 &&
    typeof value.from === "string" &&
    !Number.isNaN(new Date(value.from).getTime()) &&
    typeof value.to === "string" &&
    !Number.isNaN(new Date(value.to).getTime()) &&
    typeof value.generatedAt === "string" &&
    !Number.isNaN(new Date(value.generatedAt).getTime()) &&
    typeof value.eventCount === "number" &&
    Number.isSafeInteger(value.eventCount) &&
    value.eventCount >= 0 &&
    typeof value.contentHash === "string" &&
    typeof value.signature === "string" &&
    /^[a-f0-9]{64}$/.test(value.contentHash)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
