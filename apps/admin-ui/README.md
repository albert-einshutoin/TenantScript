# TenantScript Admin UI

Phase 1 の最小運用 UI。P1-T32 では React + Vite の起動、最小 token login、role claim 表示、Playwright smoke を対象にする。

## Local

```bash
pnpm --filter @tenantscript/admin-ui dev -- --port 4180
```

Smoke tokens:

- `manager-token`
- `viewer-token`

## Design Partner Manual Deploy

1. `pnpm --filter @tenantscript/admin-ui build`
2. `apps/admin-ui/dist/` を Cloudflare Pages の partner project にアップロードする
3. partner 環境では manager / viewer token を control-plane 側で発行し、UI には token 値だけを入力する
4. deploy 後に `pnpm --filter @tenantscript/admin-ui test` をローカルで再実行し、login smoke と approval queue が green であることを記録する
