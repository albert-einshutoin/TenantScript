# Template gallery

`apps/template-gallery` is a static discovery UI built from the checked-in
`templates/catalog.json`. It lets evaluators search by name, summary, hook, provenance, hook type,
and capability, then filter the same approved catalog by tag and capability.

## Repository verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:template-gallery
```

The gate runs component behavior tests, a production Vite build, desktop and mobile Playwright
smoke tests, horizontal-overflow checks, and axe checks for serious or critical accessibility
violations. Tier 1 retains Playwright traces and reports when this gate fails.

For local exploration:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/template-gallery dev
```

## Data and security boundary

The browser bundle imports only the public catalog projection. It does not read submission packets,
reviewer identity, evidence paths, behavior fixtures, or source file maps. Source links are
catalog-validated HTTPS URLs opened with `noopener noreferrer`. The app includes no runtime API,
credentials, analytics, external images, or remote fonts.

Provenance and hook type are exposed as deterministic tags because the current catalog does not
claim editorial categories. Capability filters include an explicit “No capabilities” option so
users can find the smallest permission surface.

## Non-guarantees and deployment status

The displayed SDK range and last-tested version are repository evidence for the pinned source
revision. They are not live npm registry checks, certification, production-suitability guarantees,
or community adoption claims. Workers Assets deployment, a production domain, trusted reuse counts,
and one-click template installation remain separate work and must not be inferred from a green
repository gate.
