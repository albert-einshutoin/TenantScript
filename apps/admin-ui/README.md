# TenantScript Admin UI

Phase 1 の最小運用 UI。React + Vite の token login、role claim 表示、tenant-scoped
dashboard、signed-cursor pagination、Playwright smoke を対象にする。

## Local

```bash
VITE_ADMIN_DEMO_MODE=true pnpm --filter @tenantscript/admin-ui dev -- --port 4180
```

Demo mode is opt-in so production builds never accept fixture credentials by default. Smoke tokens:

- `manager-token`
- `viewer-token`

The real HTTP client validates `GET /v1/session`, `GET /v1/admin/dashboard`, paginated dashboard
section responses, `GET /v1/admin/installation-review?id=...` permission reviews,
`GET /v1/admin/install-preview?versionId=...` install previews, and manager-only
`POST /v1/admin/installations` commands. Reviews and previews expose schema/capability/egress metadata
only—never configuration values, grants, manifest contents, defaults, or resolved capability scopes.
The install command accepts schema-typed config and an exact list of capabilities the manager
confirmed; app, tenant, actor, and resolved grants are derived by the Control Plane. The submitted
Bearer token is sent only in the Authorization header, retained inside the API client rather than
component state, and cleared on sign out. Responses are strictly parsed so storage-only fields fail
closed instead of reaching the component tree.

The Versions screen shows catalog history, current tenant pins, artifact hashes, and publication
times. Managers can submit `POST /v1/admin/rollbacks` only after confirming the identity-derived
tenant, plugin, current version, and target version. The UI waits for the audited server response,
refreshes the dashboard before treating the operation as complete, and exposes the audit ID,
completion timestamp, UI duration, and execution-log navigation needed by the rollback drill.

The Overview screen shows app-wide hook schema migration usage to `owner`, `admin`, and the legacy
`manager` claim. `operator` and `viewer` do not receive blocker details. A zero count is operational
evidence only; the host publishing workflow must still use the removal gate documented in
[`docs/operations/schema-migrations.md`](../../docs/operations/schema-migrations.md).

Operational health is loaded independently from `GET /v1/admin/dashboard/operations` so the legacy
dashboard response remains backward compatible. The server derives app, tenant, and UTC day from
the authenticated request and reports an integer basis-point failure rate plus actual timeout,
egress-denial, and budget-exceeded counts. The UI never estimates budget utilization when a budget
limit is not available in the dashboard read model.

The Connections screen loads a read-only inventory from `GET /v1/admin/provider-connections`.
Scope is derived from the authenticated session, and the closed response contains only provider,
workspace, bot-user, connection ID, and connection time metadata. Secret values, tokens, and even
secret-reference handles are excluded from the storage query and rejected by the UI parser. OAuth
connect, rotation, and deletion workflows remain separate privileged operations tracked in Issue
#31; this inventory must not be extended into a credential viewer.

The header shows whether anonymous aggregate telemetry is `On` or `Off`. The server response never
includes the receiver endpoint. Telemetry is off by default and is configured only in the Control
Plane Worker; see
[`docs/privacy/telemetry.md`](../../docs/privacy/telemetry.md) for the exact event schema and privacy
boundary.

Production bundle size is enforced by the repository-verified
[`Admin UI performance budget`](../../docs/reference/admin-ui-performance-budget.md). Run
`pnpm test:admin-ui-bundle-budget` from the repository root before changing frontend dependencies or
chunk boundaries. This transfer-size gate is separate from live browser performance evidence.

The executions screen keeps loaded cursor pages in memory but renders only the current scroll window.
The repository-verified
[`100k execution browser budget`](../../docs/reference/admin-ui-execution-performance.md) uses a
synthetic Playwright fixture that is excluded from the production entry. Run
`pnpm test:admin-ui-performance` from the repository root before changing row layout, virtualization,
or execution detail actions.

Automated accessibility is enforced by the repository-verified
[`Admin UI accessibility gate`](../../docs/reference/admin-ui-accessibility.md). Run
`pnpm test:admin-ui-accessibility` from the repository root when changing navigation, forms,
dialogs, tables, or privileged journeys. The gate requires unfiltered axe zero and a keyboard-only
install, rollback, and approval journey; it remains separate from manual screen-reader evidence.

Responsive rendering is enforced by the repository-verified
[`Admin UI visual regression gate`](../../docs/reference/admin-ui-visual-regression.md). Run
`pnpm test:admin-ui-visual` from the repository root for layout or state changes. Linux baselines
cover four viewports, every primary route, and empty, loading, error, large-data, and confirmation
states; baseline approval remains separate from semantic accessibility and security evidence.

The Audit log screen pages tenant-scoped events newest-first through signed cursors. Its API and UI
accept only event metadata plus the public `enabled`, `priority`, `revision`, and `version` state;
raw before/after JSON, configuration, grants, credentials, and customer payloads fail closed before
they can enter the component tree.

## Control Plane connection

公開設定のdefault、必須条件、secret境界を含む正本は
[`docs/reference/configuration.md`](../../docs/reference/configuration.md) です。このREADMEではAdmin
UI接続に必要な最小手順だけを示します。

Set the Pages build variable to the HTTPS Worker origin (loopback HTTP is accepted for local
development only):

```bash
VITE_CONTROL_PLANE_URL=https://control-plane.example.com pnpm --filter @tenantscript/admin-ui build
```

Configure the Control Plane Worker using the canonical reference rather than copying a partial
binding list into a deployment guide. In particular, `ADMIN_IDENTITIES_JSON` and
`ADMIN_CURSOR_SECRET` are design-partner bootstrap secrets and must be stored as Worker secrets,
never in Git or a public variable. Missing or malformed required bindings fail closed. A production
build ignores `VITE_ADMIN_DEMO_MODE`; fixture credentials are enabled only by the Vite development
server.

## Design Partner Manual Deploy

1. `VITE_CONTROL_PLANE_URL=https://<worker-origin> pnpm --filter @tenantscript/admin-ui build`
2. `apps/admin-ui/dist/` を Cloudflare Pages の partner project にアップロードする
3. partner 環境では manager / viewer token を control-plane 側で発行し、UI には token 値だけを入力する
4. deploy 後に `pnpm --filter @tenantscript/admin-ui test` をローカルで再実行し、login smoke と approval queue が green であることを記録する
