# Security suite v3 RBAC attack map

Security suite v3 extends the Phase 1 threat map with the Phase 2 identity, service-token, and
installation-grant boundaries. The gate is accountless and runs on every fork pull request through
`pnpm test:security`.

TenantScript has no role-mutation HTTP API. Roles, app scope, tenant scope, and service-token
operation scopes enter through a trusted identity resolver. Request bodies may describe the
business decision, but cannot replace those claims or the authenticated subject used by audit
evidence.

## Escalation matrix

| Attack                                                       | Required containment                                                | Permanent evidence                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| body `role`, `actor`, `appId`, or `tenantId` claim           | ignore or reject the claim; use identity scope and subject          | `packages/control-plane/test/security-suite.test.ts`         |
| operator self-approves an installation grant                 | reject before any approval audit or installation write              | `packages/control-plane/test/security-suite.workers.test.ts` |
| scoped admin service token calls an omitted operation        | require both role permission and `allowedOperations` membership     | `packages/control-plane/test/security-suite.test.ts`         |
| token from another tenant decides an approval                | reject even when its role can normally approve                      | `packages/control-plane/test/security-suite.test.ts`         |
| issuer creates a stronger role or forbidden machine scope    | reject role escalation and token-management/RBAC scopes             | `packages/control-plane/test/security-suite.test.ts`         |
| revoked or expired token falls back to bootstrap credentials | managed token namespace fails closed without fallback               | `packages/control-plane/test/service-tokens.workers.test.ts` |
| stored grant proposal changes plugin/version after review    | composite D1 foreign keys reject the mutation                       | `packages/control-plane/test/security-suite.workers.test.ts` |
| viewer/operator invokes privileged Admin UI actions          | controls stay absent and server authorization remains authoritative | `apps/admin-ui/src/App.test.tsx`                             |
| brokered HTTP redirects or headers escape the egress grant   | revalidate every redirect; inject exact-origin credentials only     | `packages/capabilities/test/security-suite.test.ts`          |
| plugin input forges a `kv.state` tenant, plugin, or version  | reject scope fields; bind storage facets from trusted host context  | `packages/capabilities/test/security-suite.test.ts`          |

## Review rule

Adding an RBAC operation requires all three changes in one pull request:

1. update the central role-operation fixture and published matrix;
2. add a negative attack case for every newly denied role or scope;
3. verify both the HTTP boundary and any exported non-HTTP API that accepts an identity resolver.

An Admin UI restriction is not an authorization boundary. A test is complete only when the server
or storage layer rejects the same forged request without relying on the UI.
