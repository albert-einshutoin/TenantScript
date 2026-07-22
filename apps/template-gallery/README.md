# TenantScript Template Gallery

Static, catalog-backed discovery UI for reviewed TenantScript templates. The app imports
`templates/catalog.json` at build time and does not fetch runtime APIs, analytics, external fonts, or
submission review records.

## Local verification

```sh
pnpm --filter @tenantscript/template-gallery test
pnpm --filter @tenantscript/template-gallery build
pnpm --filter @tenantscript/template-gallery test:e2e
```

Compatibility fields show repository validation evidence. They are not live npm registry checks or
certification claims. Production Workers Assets deployment remains a separate operational gate.
