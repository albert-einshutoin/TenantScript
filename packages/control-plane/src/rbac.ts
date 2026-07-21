export const RBAC_ROLES = ["owner", "admin", "operator", "viewer", "tenant-admin"] as const;

export type RbacRole = (typeof RBAC_ROLES)[number];

export const RBAC_OPERATIONS = [
  "session:read",
  "dashboard:read",
  "installation:read",
  "installation:request",
  "installation:manage",
  "rollback:execute",
  "approval:decide",
  "execution:read",
  "usage:read",
  "provider-connection:manage",
  "service-token:issue",
  "service-token:revoke",
  "rbac:manage"
] as const;

export type RbacOperation = (typeof RBAC_OPERATIONS)[number];
export type SupportedRbacRole = RbacRole | "manager";

const permissions = {
  owner: new Set<RbacOperation>(RBAC_OPERATIONS),
  admin: new Set<RbacOperation>([
    "session:read",
    "dashboard:read",
    "installation:read",
    "installation:request",
    "installation:manage",
    "rollback:execute",
    "approval:decide",
    "execution:read",
    "usage:read",
    "provider-connection:manage",
    "service-token:issue",
    "service-token:revoke"
  ]),
  operator: new Set<RbacOperation>([
    "session:read",
    "dashboard:read",
    "installation:read",
    "installation:request",
    "execution:read",
    "usage:read"
  ]),
  viewer: new Set<RbacOperation>([
    "session:read",
    "dashboard:read",
    "installation:read",
    "execution:read",
    "usage:read"
  ]),
  "tenant-admin": new Set<RbacOperation>([
    "session:read",
    "dashboard:read",
    "installation:read",
    "installation:request",
    "installation:manage",
    "rollback:execute",
    "approval:decide",
    "execution:read",
    "usage:read",
    "provider-connection:manage"
  ])
} satisfies Record<RbacRole, ReadonlySet<RbacOperation>>;

export function normalizeRbacRole(role: string): RbacRole | null {
  // Phase 1 installations issued `manager` claims. Mapping them centrally keeps the migration
  // explicit and removable without scattering privileged aliases across authorization checks.
  if (role === "manager") return "admin";
  return isRbacRole(role) ? role : null;
}

export function canRolePerform(role: string, operation: RbacOperation): boolean {
  const normalized = normalizeRbacRole(role);
  return normalized !== null && permissions[normalized].has(operation);
}

export function isSupportedRbacRole(role: unknown): role is SupportedRbacRole {
  return typeof role === "string" && normalizeRbacRole(role) !== null;
}

export function isRbacOperation(operation: unknown): operation is RbacOperation {
  return (
    typeof operation === "string" && (RBAC_OPERATIONS as readonly string[]).includes(operation)
  );
}

function isRbacRole(role: string): role is RbacRole {
  return (RBAC_ROLES as readonly string[]).includes(role);
}
