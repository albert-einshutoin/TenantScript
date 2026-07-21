import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RBAC_OPERATIONS,
  RBAC_ROLES,
  canRolePerform,
  normalizeRbacRole,
  type RbacOperation,
  type RbacRole
} from "../src/rbac.js";

const expectedPermissions = {
  owner: RBAC_OPERATIONS,
  admin: [
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
  ],
  operator: [
    "session:read",
    "dashboard:read",
    "installation:read",
    "installation:request",
    "execution:read",
    "usage:read"
  ],
  viewer: ["session:read", "dashboard:read", "installation:read", "execution:read", "usage:read"],
  "tenant-admin": [
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
  ]
} as const satisfies Record<RbacRole, readonly RbacOperation[]>;

describe("RBAC role x operation matrix", () => {
  it.each(RBAC_ROLES)("defines every operation for %s", (role) => {
    for (const operation of RBAC_OPERATIONS) {
      expect(canRolePerform(role, operation), `${role} -> ${operation}`).toBe(
        expectedPermissions[role].includes(operation as never)
      );
    }
  });

  it("maps the Phase 1 manager claim to admin without accepting unknown claims", () => {
    expect(normalizeRbacRole("manager")).toBe("admin");
    expect(normalizeRbacRole("operator")).toBe("operator");
    expect(normalizeRbacRole("super-admin")).toBeNull();
    expect(canRolePerform("manager", "approval:decide")).toBe(true);
    expect(canRolePerform("super-admin", "dashboard:read")).toBe(false);
  });

  it("reserves provider connection mutation for privileged tenant roles", () => {
    expect(RBAC_OPERATIONS).toContain("provider-connection:manage");
    expect(canRolePerform("owner", "provider-connection:manage")).toBe(true);
    expect(canRolePerform("admin", "provider-connection:manage")).toBe(true);
    expect(canRolePerform("tenant-admin", "provider-connection:manage")).toBe(true);
    expect(canRolePerform("operator", "provider-connection:manage")).toBe(false);
    expect(canRolePerform("viewer", "provider-connection:manage")).toBe(false);
  });

  it("keeps the published matrix generated from the runtime fixture", () => {
    const docs = readFileSync(join(import.meta.dirname, "../../../docs/security/rbac-matrix.md"), {
      encoding: "utf8"
    });

    for (const operation of RBAC_OPERATIONS) {
      const cells = RBAC_ROLES.map((role) =>
        expectedPermissions[role].includes(operation as never) ? "allow" : "deny"
      );
      const row = docs.split("\n").find((line) => line.includes(`\`${operation}\``));
      expect(row, `missing documentation row for ${operation}`).toBeDefined();
      expect(
        row
          ?.split("|")
          .slice(1, -1)
          .map((cell) => cell.trim())
      ).toEqual([`\`${operation}\``, ...cells]);
    }
  });
});
