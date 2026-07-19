# RBAC Matrix

- Status: implemented role model for P2-T05
- Last reviewed: 2026-07-20

TenantScript authorizes named operations through one runtime matrix. Route handlers derive app and tenant scope from the authenticated identity before applying this role decision; a role never expands the identity's tenant boundary.

`manager` is the Phase 1 compatibility claim and is normalized to `admin`. New identity providers must issue one of the five Phase 2 roles. The alias remains documented so operators can migrate existing tokens deliberately instead of silently changing their authority.

| Operation              | owner | admin | operator | viewer | tenant-admin |
| ---------------------- | ----- | ----- | -------- | ------ | ------------ |
| `session:read`         | allow | allow | allow    | allow  | allow        |
| `dashboard:read`       | allow | allow | allow    | allow  | allow        |
| `installation:read`    | allow | allow | allow    | allow  | allow        |
| `installation:request` | allow | allow | allow    | deny   | allow        |
| `installation:manage`  | allow | allow | deny     | deny   | allow        |
| `rollback:execute`     | allow | allow | deny     | deny   | allow        |
| `approval:decide`      | allow | allow | deny     | deny   | allow        |
| `execution:read`       | allow | allow | allow    | allow  | allow        |
| `usage:read`           | allow | allow | allow    | allow  | allow        |
| `service-token:issue`  | allow | allow | deny     | deny   | deny         |
| `service-token:revoke` | allow | allow | deny     | deny   | deny         |
| `rbac:manage`          | allow | deny  | deny     | deny   | deny         |

## Boundary notes

- `operator` may submit an installation request, but cannot perform the immediate installation, grant approval, rollback, or existing-installation mutation operations. The request/approval split is tracked by P2-T06 in [Issue #24](https://github.com/albert-einshutoin/TenantScript/issues/24).
- `tenant-admin` can manage resources and approvals only inside the app and tenant scope embedded in its trusted identity. It cannot issue service tokens or modify role bindings.
- Only `owner` may modify RBAC bindings. Self-role changes and indirect grant escalation must remain denied by the P2-T08 security suite.
- Service-token scopes and immediate revocation are P2-T07. Role permission is necessary but will not override a token's narrower scope.

The table is checked against the exported runtime fixture by `packages/control-plane/test/rbac.test.ts`; changing either side without the other fails CI.

## Phase 1 claim migration

1. Inventory identity-provider configuration containing the `manager` claim without recording bearer-token values.
2. Replace each `manager` claim with `admin`, or with the narrower `operator`, `viewer`, or `tenant-admin` role after checking the matrix.
3. Reissue the identity-provider token/session and revoke the previous credential through that provider. TenantScript does not persist or re-display these external bearer tokens.
4. Confirm the subject, role, app, and tenant returned by `/v1/session`, then exercise only the required operation.
5. Monitor authorization denials and audit events before removing the old claim from the identity provider.

The runtime compatibility alias prevents an immediate lockout during this migration. It does not grant an unknown claim or widen app/tenant scope. Removal of the alias must be a separately announced breaking change after service-token migration in P2-T07.
