import {
  HookContractError,
  planExecution,
  runTransformChain,
  type TransformHookResult,
  type ExecutionStep,
  type Installation,
  type HookType
} from "@tenantscript/host-sdk";
import { isHookErrorCode, type HookErrorCode } from "@tenantscript/manifest";

export interface ProxyWebhookRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: ProxyWebhookBody;
}

export type ProxyWebhookBody = Record<string, unknown>;

export interface ProxyMapping {
  inboundPath: string;
  tenantId: string;
  destinationUrl: string;
  transformHookName: string;
  hookType?: HookType;
}

export interface ProxyMappingStore {
  findProxyMappingByPath: (path: string) => Promise<ProxyMapping | null> | ProxyMapping | null;
}

export interface ProxyMappingAdminStore extends ProxyMappingStore {
  upsertProxyMapping: (mapping: ProxyMapping) => Promise<ProxyMapping> | ProxyMapping;
  deleteProxyMapping: (inboundPath: string) => Promise<boolean> | boolean;
  listProxyMappings: () => Promise<readonly ProxyMapping[]> | readonly ProxyMapping[];
}

export interface ProxyForwardRequest {
  destinationUrl: string;
  method: string;
  headers: Record<string, string>;
  body: ProxyWebhookBody;
}

export interface ProxyForwardResponse {
  status: number;
  body?: unknown;
}

export interface WebhookProxyResult {
  tenantId: string;
  destinationUrl: string;
  transformed: boolean;
  skipped: boolean;
  forwardResponse: ProxyForwardResponse;
}

export class ProxyContractError extends Error {
  override readonly name = "ProxyContractError";

  constructor(readonly code: HookErrorCode) {
    super(code);
  }
}

export function createInMemoryProxyMappingStore(params: {
  allowedDestinationOrigins: readonly string[];
}): ProxyMappingAdminStore {
  const mappings = new Map<string, ProxyMapping>();
  const allowedOrigins = params.allowedDestinationOrigins.map((origin) =>
    normalizeAllowedOrigin(origin)
  );

  return {
    upsertProxyMapping: (mapping) => {
      return Promise.resolve().then(() => {
        validateProxyMapping(mapping, allowedOrigins);
        mappings.set(mapping.inboundPath, cloneProxyMapping(mapping));
        return cloneProxyMapping(mapping);
      });
    },
    findProxyMappingByPath: (path) => {
      const mapping = mappings.get(path);
      return Promise.resolve(mapping === undefined ? null : cloneProxyMapping(mapping));
    },
    deleteProxyMapping: (inboundPath) => Promise.resolve(mappings.delete(inboundPath)),
    listProxyMappings: () =>
      Promise.resolve([...mappings.values()].map((mapping) => cloneProxyMapping(mapping)))
  };
}

export async function handleWebhookProxy(params: {
  request: ProxyWebhookRequest;
  mappingStore: ProxyMappingStore;
  resolveInstallations: (query: {
    tenantId: string;
    hookName: string;
  }) => Promise<readonly Installation[]> | readonly Installation[];
  executeTransform: (
    step: ExecutionStep,
    payload: ProxyWebhookBody
  ) => Promise<TransformHookResult<ProxyWebhookBody>> | TransformHookResult<ProxyWebhookBody>;
  forward: (request: ProxyForwardRequest) => Promise<ProxyForwardResponse> | ProxyForwardResponse;
}): Promise<WebhookProxyResult> {
  const mapping = await params.mappingStore.findProxyMappingByPath(params.request.path);
  if (mapping === null) {
    throw new ProxyContractError("input_invalid");
  }

  if (mapping.hookType !== undefined && mapping.hookType !== "transform") {
    throw new ProxyContractError("input_invalid");
  }
  if (mapping.transformHookName !== "webhook.outbound") {
    throw new ProxyContractError("input_invalid");
  }

  const installations = await params.resolveInstallations({
    tenantId: mapping.tenantId,
    hookName: mapping.transformHookName
  });
  const plan = planExecution({
    hookName: mapping.transformHookName,
    hookType: mapping.hookType ?? "transform",
    installations
  });

  let body = params.request.body;
  let transformed = false;
  try {
    body = await runTransformChain(plan, body, params.executeTransform);
    transformed = plan.steps.length > 0;
  } catch (error) {
    if (error instanceof ProxyContractError) throw error;
    if (error instanceof HookContractError) throw new ProxyContractError(error.code);
    throw new ProxyContractError(
      isRecord(error) && isHookErrorCode(error.code) ? error.code : "plugin_result_invalid"
    );
  }

  const forwardResponse = await params.forward({
    destinationUrl: mapping.destinationUrl,
    method: params.request.method,
    headers: params.request.headers,
    body
  });

  return {
    tenantId: mapping.tenantId,
    destinationUrl: mapping.destinationUrl,
    transformed,
    skipped: false,
    forwardResponse
  };
}

function validateProxyMapping(
  mapping: ProxyMapping,
  allowedDestinationOrigins: readonly string[]
): void {
  if (
    !mapping.inboundPath.startsWith("/") ||
    mapping.transformHookName !== "webhook.outbound" ||
    (mapping.hookType !== undefined && mapping.hookType !== "transform")
  ) {
    throw new ProxyContractError("input_invalid");
  }

  const destination = parseDestinationUrl(mapping.destinationUrl);
  if (!isPublicHttpUrl(destination)) {
    throw new ProxyContractError("input_invalid");
  }
  if (!allowedDestinationOrigins.includes(destination.origin)) {
    throw new ProxyContractError("input_invalid");
  }
}

function parseDestinationUrl(destinationUrl: string): URL {
  try {
    return new URL(destinationUrl);
  } catch {
    throw new ProxyContractError("input_invalid");
  }
}

function normalizeAllowedOrigin(origin: string): string {
  return parseDestinationUrl(origin).origin;
}

function isPublicHttpUrl(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || isPrivateIpv6(hostname)) {
    return false;
  }
  return !isPrivateIpv4(hostname);
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function cloneProxyMapping(mapping: ProxyMapping): ProxyMapping {
  return { ...mapping };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
