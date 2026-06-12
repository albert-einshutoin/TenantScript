import {
  planExecution,
  runTransformChain,
  type ExecutionStep,
  type Installation
} from "@tenantscript/host-sdk";

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
}

export interface ProxyMappingStore {
  findProxyMappingByPath: (path: string) => Promise<ProxyMapping | null> | ProxyMapping | null;
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
  ) => Promise<ProxyWebhookBody> | ProxyWebhookBody;
  forward: (request: ProxyForwardRequest) => Promise<ProxyForwardResponse> | ProxyForwardResponse;
}): Promise<WebhookProxyResult> {
  const mapping = await params.mappingStore.findProxyMappingByPath(params.request.path);
  if (mapping === null) {
    throw new Error(`proxy mapping for ${params.request.path} was not found`);
  }

  const installations = await params.resolveInstallations({
    tenantId: mapping.tenantId,
    hookName: mapping.transformHookName
  });
  const plan = planExecution({
    hookName: mapping.transformHookName,
    hookType: "transform",
    installations
  });

  let body = params.request.body;
  let transformed = false;
  let skipped = false;
  try {
    body = await runTransformChain(plan, body, params.executeTransform);
    transformed = plan.steps.length > 0;
  } catch {
    body = params.request.body;
    skipped = true;
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
    skipped,
    forwardResponse
  };
}
