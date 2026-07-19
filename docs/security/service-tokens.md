# Service token security and incident response

TenantScript service tokens are tenant-scoped bearer credentials for non-interactive clients. They are deliberately narrower than human/bootstrap identities: every token has one RBAC role, an explicit operation allowlist, an expiry, and an immediate revocation path.

## Security contract

- `POST /v1/admin/service-tokens` requires `service-token:issue` and accepts `label`, canonical `role`, `scopes`, and an RFC 3339 `expiresAt` no more than 90 days ahead.
- The requested role cannot contain permissions the issuer does not have. Operators, viewers, and tenant admins cannot issue tokens.
- Scope is an additional deny boundary. Both the role matrix and the token scope must allow an operation.
- Machine credentials cannot receive `service-token:issue`, `service-token:revoke`, or `rbac:manage`. A leaked service token therefore cannot mint or revoke credentials or change RBAC policy.
- The response contains the raw `ts_service_...` credential once. D1 stores only its SHA-256 digest, metadata, expiry, and revocation evidence. There is no API that reads the raw credential again.
- `DELETE /v1/admin/service-tokens?id=<id>` requires `service-token:revoke`. Lookup and update include the authenticated app and tenant, so missing and cross-tenant IDs share the same `404` response.
- Issue and revoke operations use the privileged Admin mutation rate limiter and fail closed if that protection is unavailable.

## Issue and store a token

Request the smallest role and operation set the workload needs. The following token can establish a session and read the dashboard, but cannot install, approve, roll back, or manage other tokens.

```http
POST /v1/admin/service-tokens HTTP/1.1
Authorization: Bearer <owner-or-admin-bootstrap-token>
Content-Type: application/json

{
  "label": "production-observer",
  "role": "viewer",
  "scopes": ["session:read", "dashboard:read"],
  "expiresAt": "2026-08-20T00:00:00.000Z"
}
```

Copy the returned `token` directly into the workload's secret manager. Do not place it in source control, shell history, issue text, CI logs, screenshots, or D1. If the response is lost, revoke the token ID and issue a replacement; the credential cannot be recovered.

## Leak response and immediate revocation

1. Record the suspected token ID, affected app/tenant, discovery time, and reporter in the private incident record. Never paste the raw credential.
2. Revoke it with an owner/admin identity:

   ```http
   DELETE /v1/admin/service-tokens?id=<token-id> HTTP/1.1
   Authorization: Bearer <owner-or-admin-bootstrap-token>
   ```

3. Confirm the response is `204`. A subsequent request with the leaked bearer must return `401`; revocation does not wait for a cache or deployment.
4. Query operational logs for the service subject `service-token:<token-id>` and review actions between the last known safe time and revocation. Do not search for or log the raw token.
5. Rotate any downstream secret the workload could access, issue a least-privilege replacement, update the workload secret manager, and verify the old token still returns `401`.
6. If an attacker may have obtained a bootstrap token, rotate that deployment secret separately and review every service token issued by its subject.

## Migration from static bootstrap identities

Migration `0007_service_tokens.sql` creates the hash-only table and enforces the app/tenant relationship with a composite foreign key. Apply all D1 migrations before deploying the Worker code; otherwise managed-token authentication and mutation routes fail closed.

`ADMIN_IDENTITIES_JSON` remains a temporary bootstrap path for owner/admin access. For each automation currently represented there:

1. apply migration `0007` and deploy the Worker;
2. issue a scoped service token with the shortest practical expiry;
3. move the raw token to the workload secret manager and verify its allowed and denied operations;
4. remove the automation's static entry from `ADMIN_IDENTITIES_JSON` and redeploy;
5. retain only the minimum break-glass bootstrap identities required to issue and revoke managed tokens.

The legacy `manager` bootstrap claim still normalizes to `admin` during migration, but newly issued service tokens accept canonical roles only.
