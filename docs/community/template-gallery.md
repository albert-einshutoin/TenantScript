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
violations. It then runs the pinned workspace Wrangler against the static-only Workers Assets
configuration in dry-run mode. Tier 1 retains Playwright traces and reports when the UI gate fails.

For local exploration:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/template-gallery dev
```

## Data and security boundary

The browser bundle imports only the public catalog projection. It does not read submission packets,
reviewer identity, evidence paths, behavior fixtures, or source file maps. GitHub source links open
the exact reviewed tree identified by `source.revision` with `noopener noreferrer`. For a provider
without a known immutable URL pattern, the UI names the destination as a repository and displays the
reviewed revision instead of inventing a pinned link. The app includes no runtime API, credentials,
analytics, external images, or remote fonts.

Provenance and hook type are exposed as deterministic tags because the current catalog does not
claim editorial categories. Capability filters include an explicit “No capabilities” option so
users can find the smallest permission surface.

## Production release contract

The `Publish Template Gallery` workflow is manual-only. It accepts a full commit SHA, verifies that
the checked-out revision is an ancestor of `main`, repeats the gallery test, build, and Workers
Assets dry-run, and then deploys only `apps/template-gallery/dist`. Pull requests, forks, pushes, and
schedules cannot start the credentialed lane.

Before the first deployment, a maintainer must:

1. Create a protected `template-gallery-production` GitHub environment with required reviewers.
2. Add environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Use a dedicated,
   short-lived token limited to the gallery Worker deployment; do not reuse runtime or tenant-data
   credentials.
3. Choose a reviewed full SHA from `main`, dispatch `Publish Template Gallery` from `main`, enter the
   SHA, and explicitly confirm the production deployment.
4. Verify the public deployment URL in a clean browser: load the catalog, apply a search/filter,
   open the reviewed-source link, reload a client-side route, and confirm that no analytics or
   credential request appears.
5. Record only the commit SHA, Actions run URL, public deployment URL, verification time, and result.
   Do not copy tokens, account IDs, or raw provider responses into issues.

For rollback, dispatch the same workflow with a previously reviewed full SHA that is still an
ancestor of `main`. Do not rewrite Git history or deploy an unreviewed local build. A successful
dry-run, an enabled workflow, or an unverified provider response is not production evidence.

The static-assets settings follow Cloudflare's
[SPA configuration](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
and intentionally omit Worker code and runtime bindings.

## Non-guarantees and deployment status

The displayed SDK range and last-tested version are repository evidence for the pinned source
revision. They are not live npm registry checks, certification, production-suitability guarantees,
or community adoption claims. The repository contains a guarded Workers Assets release contract,
but no production deployment has been performed or verified by this change. A production domain,
trusted reuse counts, and one-click template installation remain separate work and must not be
inferred from a green repository gate.
