# Public configuration reference

This page is the canonical inventory of configuration read by TenantScript's shipped entrypoints.
Values marked **Secret: Yes** belong in the platform's secret store and must never be committed,
printed by diagnostics, placed in client-side build variables, or copied into issues. Resource
bindings such as D1, Durable Objects, and Worker Loaders are privileged capabilities even when the
binding name itself is not a secret.

## Control Plane Worker

These names are read by `packages/control-plane/src/worker-entry.ts`.

| Name                                   | Default                               | Required when                                                          | Secret | Purpose                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_ALLOWED_ORIGINS`                | `[]`                                  | A browser-hosted Admin UI calls the Worker                             | No     | JSON array of exact HTTPS origins. Loopback HTTP is accepted only for local development; wildcards fail closed.                                                                                                         |
| `ADMIN_CURSOR_SECRET`                  | Unset                                 | Dashboard pagination is enabled                                        | Yes    | At least 32 bytes used to sign app-, tenant-, and section-scoped cursors.                                                                                                                                               |
| `ADMIN_IDENTITIES_JSON`                | Unset                                 | Bootstrap identities are still used                                    | Yes    | JSON object keyed by raw bootstrap bearer token. Prefer managed service tokens after bootstrap.                                                                                                                         |
| `ADMIN_HOOK_SCHEMA_CATALOG_JSON`       | `{}`                                  | Published hook schemas are displayed or migration removal is evaluated | No     | JSON object mapping hook names to their published stable versions. It must match host payload routing.                                                                                                                  |
| `ADMIN_MUTATION_RATE_LIMIT`            | `20`                                  | `ADMIN_MUTATION_RATE_LIMITER_DO` is configured                         | No     | Maximum reservations per actor, tenant, and mutation family in one window; valid range 1–10,000.                                                                                                                        |
| `ADMIN_MUTATION_RATE_WINDOW_SECONDS`   | `60`                                  | `ADMIN_MUTATION_RATE_LIMITER_DO` is configured                         | No     | Fixed-window duration; valid range 1–86,400 seconds.                                                                                                                                                                    |
| `ADMIN_MUTATION_RATE_LIMITER_DO`       | Unset                                 | Admin mutation endpoints are exposed                                   | No     | Durable Object namespace for atomic mutation-rate reservations. Missing protection makes guarded mutations fail closed.                                                                                                 |
| `APP_DATABASE_ROUTES_JSON`             | Unset; single-`DB` compatibility mode | App-level D1 sharding is enabled                                       | No     | JSON map from trusted app ID to an uppercase D1 binding name. It must contain neither database UUIDs nor credentials.                                                                                                   |
| `DB`                                   | Unset                                 | Persistent Control Plane state or managed service tokens are used      | No     | D1 binding. In compatibility mode it stores tenant data; in sharded mode it is limited to the authentication directory and telemetry aggregate. Apply every migration before deploy.                                    |
| `EXECUTION_ARCHIVE`                    | Unset                                 | Scheduled execution retention is enabled                               | No     | Private R2 binding for content-addressed execution evidence. The generated production template derives its bucket target from the setup operation key.                                                                  |
| `EXECUTION_ARCHIVE_HOT_RETENTION_DAYS` | Unset; retention disabled             | `EXECUTION_ARCHIVE` is configured                                      | No     | Integer from 1 through 3,650. Missing policy keeps scheduled retention off; invalid or incomplete configuration fails the scheduled event before storage access.                                                        |
| `PROVIDER_SECRET_KEYRING_JSON`         | Unset                                 | Provider tokens are stored or resolved                                 | Yes    | Exact JSON object with `currentKeyId` and `keys`; each key is an ID plus unpadded base64url-encoded 32-byte AES key material. Provider token values are limited to 16 KiB. Supply only through a Worker secret binding. |
| `PROVIDER_SECRET_STORE_DO`             | Unset                                 | Provider tokens are stored or resolved                                 | No     | Tenant-isolated SQLite Durable Object namespace for encrypted provider-token envelopes. Its class lifecycle is owned by the Control Plane Worker deployment.                                                            |
| `OAUTH_STATE_STORE_DO`                 | Unset                                 | Provider OAuth install/callback routes are enabled                     | No     | Sharded SQLite Durable Object namespace for digest-only, browser/app/tenant/actor/redirect-bound, one-time OAuth state records.                                                                                         |
| `TENANTSCRIPT_TELEMETRY_ENABLED`       | Unset or `false`                      | Anonymous telemetry is explicitly opted in                             | No     | Only the exact string `true` enables scheduled telemetry; telemetry is off by default.                                                                                                                                  |
| `TENANTSCRIPT_TELEMETRY_ENDPOINT`      | Unset                                 | Telemetry is enabled                                                   | No     | Credential-free public HTTPS receiver URL without query or fragment. The receiver endpoint is never returned by the Admin API.                                                                                          |
| `TENANTSCRIPT_PRODUCT_VERSION`         | Unset                                 | Telemetry is enabled                                                   | No     | Semantic version included in the closed anonymous event schema.                                                                                                                                                         |
| `TENANTSCRIPT_RUNTIME_PRIMITIVE`       | Unset                                 | Telemetry is enabled                                                   | No     | One of `cloudflare-workers`, `dynamic-workers`, or `workers-for-platforms`.                                                                                                                                             |
| `USAGE_ANALYTICS`                      | Unset; D1 summaries remain available  | Analytics Engine usage events are enabled                              | No     | Analytics Engine dataset binding for the fixed, value-bounded usage schema. Dataset writes are best-effort and never become execution authority.                                                                        |

Sharded deployments additionally use operator-defined app database bindings such as
`APP_ACME_DB`. Every value referenced by `APP_DATABASE_ROUTES_JSON` must exist, and one binding
cannot be reused by two apps. Binding names are not additional fixed environment variables.

The generated production template installs a daily Cron Trigger for explicit execution retention;
opted-in telemetry shares that scheduled event while retaining independent failure visibility. The
repository installs no telemetry collector. See [Execution retention](../operations/execution-retention.md),
[Telemetry and privacy](../privacy/telemetry.md),
[App database routing](../operations/app-database-routing.md),
[Usage meter operations](../operations/usage-meter.md), and
[Admin mutation rate limits](../operations/admin-mutation-rate-limits.md).

## Admin UI

Vite variables are embedded into the browser bundle. They are public by definition and must never
contain bearer tokens, account identifiers, customer data, or other credentials.

| Name                     | Default                               | Required when                    | Secret | Purpose                                                                                                 |
| ------------------------ | ------------------------------------- | -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `VITE_CONTROL_PLANE_URL` | Unset; API client remains unavailable | Building a connected Admin UI    | No     | Exact HTTPS Control Plane origin. Loopback HTTP is accepted only during development.                    |
| `VITE_ADMIN_DEMO_MODE`   | Unset or `false`                      | Running local fixture-only demos | No     | Only exact `true` in the Vite development server enables demo credentials. Production builds ignore it. |

## CLI

| Name                               | Default | Required when                                      | Secret | Purpose                                                                                                                                                                         |
| ---------------------------------- | ------- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENANTSCRIPT_CONTROL_PLANE_URL`   | Unset   | Running `ext rollback` or `ext approvals` live     | No     | Exact HTTPS Control Plane origin without path, query, fragment, or userinfo. Loopback HTTP is accepted only for local development.                                              |
| `TENANTSCRIPT_CONTROL_PLANE_TOKEN` | Unset   | Running an authenticated Admin mutation from `ext` | Yes    | Bearer service token supplied only through the request header. Never place it in the URL, arguments, committed configuration, logs, or issues.                                  |
| `CLOUDFLARE_ACCOUNT_ID`            | Unset   | Running `ext doctor --cloudflare`                  | Yes    | Account-scoped API identifier read only by the binary composition root. It is never accepted as a CLI argument or emitted in diagnostics.                                       |
| `CLOUDFLARE_API_TOKEN`             | Unset   | Running `ext doctor --cloudflare`                  | Yes    | Least-privilege token with D1 Read. The live doctor does not call Worker or secret APIs. It is used only in the Authorization header and never accepted in arguments or output. |

## Runtime benchmark

| Name     | Default     | Required when                  | Secret | Purpose                                                                          |
| -------- | ----------- | ------------------------------ | ------ | -------------------------------------------------------------------------------- |
| `LOADER` | No fallback | Deploying `apps/runtime-bench` | No     | Cloudflare Worker Loader binding used for live `get` and `load` benchmark modes. |

Cloudflare account details, deployment credentials, and paid-plan access are maintainer environment
prerequisites, not application variables, and never belong in repository configuration.

## Proxy

The Proxy package has no public environment variables or platform bindings. Runtime configuration
is supplied through typed arguments: destination-origin allowlist, mapping store, installation
resolver, transform executor, and forwarder. Allowed origins are not secrets, but destination
mappings are operational tenant data and must not be copied from a real deployment into examples.

## Example SaaS

The Example SaaS has no public environment variables or platform bindings. It deliberately uses
in-memory stores and mock Slack delivery so its tests remain fork-safe and credential-free. Its
placeholder provider token is a non-routable fixture, not a deployable credential.

## Contributor update rule

When an entrypoint reads a new public setting, update this reference and its owning component README
in the same pull request. `scripts/configuration-doc-contract.test.mjs` discovers fixed Control
Plane, Admin UI, CLI, and runtime benchmark names from source/configuration files so an undocumented
addition fails the documentation gate.

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:docs
pnpm lint:docs
pnpm test:telemetry-contract
pnpm format
```
