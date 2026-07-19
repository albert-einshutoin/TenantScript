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
section responses, and `GET /v1/admin/installation-review?id=...` permission reviews. The permission review
is read-only for both manager and viewer roles: it exposes schema/capability/egress metadata only,
never configuration values, grants, manifest contents, defaults, or resolved capability scopes. The submitted Bearer token is sent only in the Authorization header, retained
inside the API client rather than component state, and cleared on sign out. Dashboard responses are
strictly parsed so storage-only fields fail closed instead of reaching the component tree.

## Control Plane connection

Set the Pages build variable to the HTTPS Worker origin (loopback HTTP is accepted for local
development only):

```bash
VITE_CONTROL_PLANE_URL=https://control-plane.example.com pnpm --filter @tenantscript/admin-ui build
```

Configure these Worker bindings:

- `ADMIN_ALLOWED_ORIGINS`: JSON array of exact HTTPS Admin UI origins, for example
  `["https://admin.example.com"]`.
- `ADMIN_IDENTITIES_JSON`: secret JSON object keyed by bearer token. Each value must contain
  `subject`, `role` (`manager` or `viewer`), `appId`, and `tenantId`.
- `ADMIN_CURSOR_SECRET`: secret with at least 32 bytes used to authenticate tenant- and
  section-scoped pagination cursors.
- `DB`: D1 binding containing the Control Plane schema from
  `packages/control-plane/migrations/0001_initial.sql`.

`ADMIN_IDENTITIES_JSON` and `ADMIN_CURSOR_SECRET` are design-partner bootstrap secrets and must be
stored as Worker secrets, never in Git or a public variable. Missing or malformed bindings fail
closed. A production build ignores `VITE_ADMIN_DEMO_MODE`; fixture credentials are enabled only by
the Vite development server.

## Design Partner Manual Deploy

1. `VITE_CONTROL_PLANE_URL=https://<worker-origin> pnpm --filter @tenantscript/admin-ui build`
2. `apps/admin-ui/dist/` を Cloudflare Pages の partner project にアップロードする
3. partner 環境では manager / viewer token を control-plane 側で発行し、UI には token 値だけを入力する
4. deploy 後に `pnpm --filter @tenantscript/admin-ui test` をローカルで再実行し、login smoke と approval queue が green であることを記録する
