# ADR-004: App-level D1 sharding

Date: 2026-07-20
Deciders: TenantScript maintainers
Status: Accepted

## Context

Private Beta places multiple host apps and tenants behind one Control Plane. Tenant predicates are
still required, but one accidental missing predicate must not expose a different host app. D1 is
designed to scale horizontally across smaller databases and has a fixed per-database size limit.

Cloudflare's current documentation requires a Worker binding before the Worker Binding API can
query a D1 database. A Worker script can have approximately 5,000 resource bindings, while D1
supports 50,000 databases on Workers Paid and 10 on Free. The D1 REST API can create databases with
`D1 Write`, but Cloudflare describes REST queries as administrative and subject to the global API
rate limit.

Sources checked on 2026-07-20:

- <https://developers.cloudflare.com/d1/get-started/>
- <https://developers.cloudflare.com/d1/platform/limits/>
- <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/>
- <https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/>

We compared:

1. multiple D1 bindings on one Worker;
2. D1 REST queries selected dynamically by database ID; and
3. provisioning a separate Worker deployment for each bounded group of app databases.

## Decision

TenantScript assigns one D1 database to one host app. Setup-time tooling or an operator creates the
database, applies migrations, adds a named Worker binding, records `appId -> binding name`, and
deploys the updated configuration. Request-time code never creates a database.

The runtime boundary is `AppDatabaseRouter.resolve(authenticatedIdentity.appId)`. Routing is exact,
has no shared-database fallback, rejects duplicate app IDs, and rejects reuse of one database
binding by multiple apps. Tenant ID remains a mandatory predicate inside the selected app database.

The D1 REST API may be used by setup/provisioning automation with a least-privilege `D1 Write`
token. It is rejected for request-path queries because it would put an account API token in the
data path, inherit global API rate limits, and weaken the Worker binding boundary.

When one Worker approaches its binding metadata limit, operators create another Control Plane
deployment and assign a bounded group of apps to it. A global authentication/routing directory may
identify the deployment, but it must contain no tenant payload, plugin configuration, execution
content, or provider secret.

## Consequences

- Cross-app isolation gains a physical D1 boundary in addition to SQL predicates.
- Unknown or unprovisioned apps fail closed instead of falling back to the legacy shared `DB`.
- Adding an app requires provisioning, migration, binding configuration, and deployment work.
- Free-plan self-hosting is limited by the current D1 database count; paid-plan limits must be
  checked before onboarding many apps.
- A single Worker cannot represent an unbounded app population through bindings; deployment-level
  partitioning is the scale-out path.
- The existing single-`DB` Worker composition remains a compatibility path until setup and identity
  directory integration is completed. It must not be described as physically sharded.
