# Phase 0 Benchmarks

## Runtime Latency

Status: blocked on Cloudflare paid Workers plan as of 2026-06-12.

Harness:

- App: `apps/runtime-bench`
- Worker: `tenantscript-phase0-runtime-bench`
- Warm candidate: `GET /bench?mode=get&iterations=80&warmup=10`
- Cold/create candidate: `GET /bench?mode=load&iterations=40&warmup=0`
- Metric: `addedLatencyMs.p95`, measured as Dynamic Worker transform latency minus local
  baseline transform latency for the same payload.

Validated locally:

```sh
pnpm --filter @tenantscript/runtime-bench typecheck
pnpm --filter @tenantscript/runtime-bench lint
pnpm --filter @tenantscript/runtime-bench exec wrangler deploy --config wrangler.jsonc --dry-run
```

Live deploy attempt:

```sh
pnpm --filter @tenantscript/runtime-bench run deploy
```

Result:

```text
Cloudflare API code 10195: In order to use Dynamic Workers, you must switch to a paid plan.
```

Go/No-Go:

- Warm p95 target: `< 50ms`
- Cold/create p95 target: `< 300ms`
- Decision: not available until the paid-plan blocker is removed and live measurements are run.

## Tier 2 activation

The scheduled Tier 2 workflow contains the reviewed live lane, but a skipped lane is **not live
evidence**. Keep `TIER2_LIVE_ENABLED` unset until a maintainer has all of the following:

- a paid Cloudflare plan that permits Dynamic Workers;
- a protected `cloudflare-live` GitHub environment;
- environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with only the required
  deployment authority; and
- a Cloudflare Access application protecting the benchmark origin plus environment secrets
  `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` for its least-authority service token; and
- the fixed `tenantscript-phase0-runtime-bench` Worker covered by that Access application.

Set repository variable `TIER2_LIVE_ENABLED=true` only after those controls are reviewed. The workflow
deploys from `main`, checks `/health`, runs the exact warm and cold/create scenarios above, and retains
a closed sanitized JSON artifact for 30 days. It follows no redirects, sends only the Access service
token to the prevalidated benchmark origin, never writes that token to evidence, bounds response size
and request time, and first requires `/health` to reject an anonymous request so a missing Access
policy cannot produce passing evidence. It fails when warm p95 reaches 50 ms or cold/create p95
reaches 300 ms.

The workflow does not accept a mutable benchmark URL. Before deployment it asks Cloudflare's fixed
API origin for the authenticated account's `workers.dev` subdomain and combines that value with the
reviewed Worker name. Access credentials are sent only to that derived origin.

This is an absolute Phase 0 Go/No-Go gate. A 20% regression claim requires a reviewed live baseline
and is not inferred from repository tests. On failure, do not raise thresholds or enable a token
fallback. Review the sanitized artifact and Cloudflare deployment separately, leaving credentials,
account identifiers, and raw provider responses out of issues and logs.
