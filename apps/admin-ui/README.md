# TenantScript Admin UI

Phase 1 の最小運用 UI。P1-T32 では React + Vite の起動、最小 token login、role claim 表示、Playwright smoke を対象にする。

## Local

```bash
VITE_ADMIN_DEMO_MODE=true pnpm --filter @tenantscript/admin-ui dev -- --port 4180
```

Demo mode is opt-in so production builds never accept fixture credentials by default. Smoke tokens:

- `manager-token`
- `viewer-token`

The real HTTP session client validates `GET /v1/session` responses. The submitted Bearer token is
sent only in the Authorization header and is not added to the identity passed through the component
tree. Until the tenant-scoped dashboard read model is implemented, dashboard loading fails closed
instead of mixing real authentication with fixture dashboard data.

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

`ADMIN_IDENTITIES_JSON` is a design-partner bootstrap and must be stored as a Worker secret, never in
Git or a public variable. Missing or malformed bindings fail closed. A production build ignores
`VITE_ADMIN_DEMO_MODE`; fixture credentials are enabled only by the Vite development server.

## Design Partner Manual Deploy

1. `VITE_CONTROL_PLANE_URL=https://<worker-origin> pnpm --filter @tenantscript/admin-ui build`
2. `apps/admin-ui/dist/` を Cloudflare Pages の partner project にアップロードする
3. partner 環境では manager / viewer token を control-plane 側で発行し、UI には token 値だけを入力する
4. deploy 後に `pnpm --filter @tenantscript/admin-ui test` をローカルで再実行し、login smoke と approval queue が green であることを記録する
