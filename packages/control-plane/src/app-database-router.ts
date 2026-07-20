import type { D1DatabaseLike } from "./storage.js";

export interface AppDatabaseRoute {
  appId: string;
  database: D1DatabaseLike;
}

export interface AppDatabaseRouter {
  resolve: (appId: string) => D1DatabaseLike | null;
}

export function createStaticAppDatabaseRouter(
  routes: readonly AppDatabaseRoute[]
): AppDatabaseRouter {
  const databases = new Map<string, D1DatabaseLike>();
  const assignedDatabases = new Set<D1DatabaseLike>();
  for (const route of routes) {
    if (!isAppId(route.appId)) {
      throw new Error("invalid app database route");
    }
    if (databases.has(route.appId)) {
      throw new Error(`duplicate app database route: ${route.appId}`);
    }
    if (assignedDatabases.has(route.database)) {
      throw new Error("app database binding must not be reused");
    }
    databases.set(route.appId, route.database);
    assignedDatabases.add(route.database);
  }

  return {
    // Unknown apps intentionally have no fallback. Falling back to a shared database here would
    // turn a provisioning mistake into a cross-app data-placement failure.
    resolve: (appId) => databases.get(appId) ?? null
  };
}

export function createAppDatabaseRouterFromBindings(params: {
  serializedRoutes: string;
  bindings: Readonly<Record<string, unknown>>;
}): AppDatabaseRouter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.serializedRoutes);
  } catch {
    throw new Error("app database routes must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("app database routes must be a JSON object");
  }

  const usedBindings = new Set<string>();
  const routes: AppDatabaseRoute[] = [];
  for (const [appId, bindingName] of Object.entries(parsed)) {
    if (!isAppId(appId)) throw new Error("invalid app database route");
    if (typeof bindingName !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(bindingName)) {
      throw new Error("invalid app database binding name");
    }
    if (usedBindings.has(bindingName)) {
      throw new Error("app database binding must not be reused");
    }
    const database = params.bindings[bindingName];
    if (!isD1Database(database)) {
      // Do not reflect the binding value: it may be a secret or another privileged resource.
      throw new Error("app database binding is unavailable");
    }
    usedBindings.add(bindingName);
    routes.push({ appId, database });
  }
  return createStaticAppDatabaseRouter(routes);
}

function isAppId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isD1Database(value: unknown): value is D1DatabaseLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "prepare" in value &&
    typeof value.prepare === "function"
  );
}
