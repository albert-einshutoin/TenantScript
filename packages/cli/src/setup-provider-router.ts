import type { SetupProviderAdapter } from "./setup-executor.js";

export interface SetupProviderRoute {
  operationIds: readonly string[];
  adapter: SetupProviderAdapter;
}

export type SetupProviderRouterErrorCode =
  | "setup_provider_invalid_configuration"
  | "setup_provider_route_not_found";

export class SetupProviderRouterError extends Error {
  override readonly name = "SetupProviderRouterError";

  constructor(readonly code: SetupProviderRouterErrorCode) {
    super(code);
  }

  toJSON(): { code: SetupProviderRouterErrorCode } {
    return { code: this.code };
  }
}

export function createSetupProviderRouter(params: {
  routes: readonly SetupProviderRoute[];
}): SetupProviderAdapter {
  const owners = validateAndIndexRoutes(params);

  const requireOwner = (operationId: unknown): SetupProviderAdapter => {
    if (!isOperationId(operationId)) throw routeNotFound();
    const owner = owners.get(operationId);
    if (owner === undefined) throw routeNotFound();
    return owner;
  };

  return {
    reconcile: async (request) => requireOwner(request.operation.id).reconcile(request),
    cleanupCreated: async (request) => requireOwner(request.operation.id).cleanupCreated(request)
  };
}

function validateAndIndexRoutes(params: unknown): ReadonlyMap<string, SetupProviderAdapter> {
  if (
    !isRecord(params) ||
    !hasOnlyKeys(params, ["routes"]) ||
    !Array.isArray(params.routes) ||
    params.routes.length === 0
  ) {
    throw invalidConfiguration();
  }

  const owners = new Map<string, SetupProviderAdapter>();
  for (const route of params.routes) {
    if (
      !isRecord(route) ||
      !hasOnlyKeys(route, ["operationIds", "adapter"]) ||
      !Array.isArray(route.operationIds) ||
      route.operationIds.length === 0 ||
      !isAdapter(route.adapter)
    ) {
      throw invalidConfiguration();
    }
    for (const operationId of route.operationIds) {
      if (!isOperationId(operationId) || owners.has(operationId)) {
        throw invalidConfiguration();
      }
      owners.set(operationId, route.adapter);
    }
  }
  return owners;
}

function isAdapter(value: unknown): value is SetupProviderAdapter {
  return (
    isRecord(value) &&
    typeof value.reconcile === "function" &&
    typeof value.cleanupCreated === "function"
  );
}

function isOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function invalidConfiguration(): SetupProviderRouterError {
  return new SetupProviderRouterError("setup_provider_invalid_configuration");
}

function routeNotFound(): SetupProviderRouterError {
  return new SetupProviderRouterError("setup_provider_route_not_found");
}
