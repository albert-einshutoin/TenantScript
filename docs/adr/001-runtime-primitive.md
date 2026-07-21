# ADR-001: Runtime Primitive Selection

Date: 2026-06-12
Deciders: TenantScript maintainers
Status: Blocked

## Blockers

Live benchmark evidence is blocked pending a paid Cloudflare Workers plan and a completed live
benchmark run. Dynamic Workers require the Workers Paid plan; the current account cannot deploy
`apps/runtime-bench` until that prerequisite is met.

## Context

Phase 0 must compare Dynamic Workers and Workers for Platforms for tenant plugin execution.
The comparison criteria are cold/warm latency, limits, egress control, local development
experience, and plan/cost burden for self-host adopters.

Cloudflare's current Dynamic Workers docs state that the Worker Loader can `load()` one-off code
or `get()` a cached worker by ID, and that `globalOutbound: null` blocks direct network access.
The API reference also notes that `get()` can reuse warm isolates but does not guarantee reuse.
Cloudflare's Dynamic Workers pricing page states that Dynamic Workers require the Workers Paid
plan and are billed by unique Dynamic Workers created per day, requests, and CPU time.

Workers for Platforms remains the main alternative. Cloudflare documents dispatch namespaces as
containers for customer Workers, and custom limits as CPU/subrequest limits that throw when
exceeded.

Sources checked on 2026-06-12:

- <https://developers.cloudflare.com/dynamic-workers/getting-started/>
- <https://developers.cloudflare.com/dynamic-workers/api-reference/>
- <https://developers.cloudflare.com/dynamic-workers/pricing/>
- <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/>
- <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/>

## Evidence

Added `apps/runtime-bench`, a minimal Dynamic Worker benchmark harness:

- `mode=get`: uses `env.LOADER.get("payload-transformer:v1", ...)` for warm-path measurement.
- `mode=load`: uses `env.LOADER.load(...)` for create-per-call measurement.
- Both modes transform the same `webhook.outbound` payload and report baseline, dynamic, and
  added latency percentiles.

Local validation passed:

```sh
pnpm --filter @tenantscript/runtime-bench typecheck
pnpm --filter @tenantscript/runtime-bench lint
pnpm --filter @tenantscript/runtime-bench exec wrangler deploy --config wrangler.jsonc --dry-run
```

Live deploy was attempted with the authenticated Wrangler account and failed:

```text
In order to use Dynamic Workers, you must switch to a paid plan
[account-specific dashboard URL redacted] [code: 10195]
```

On 2026-07-21, Issue #288 added an accountless production-caller contract for the preferred
Dynamic Workers candidate. It verifies artifact integrity, derives cached worker IDs from the full
tenant capability scope, disables global outbound access, applies per-invocation limits, bounds the
wire contract, adapts deployed CommonJS handler bundles through a fixed ES module wrapper, enforces
a host-side wall-clock abort in addition to Cloudflare CPU/subrequest limits, and records trusted
execution evidence through the control-plane recorder. Its Tier 1 security tests do not substitute
for the blocked live latency or isolation comparison.

The caller intentionally records zero CPU milliseconds synchronously. Cloudflare documents exact
`CPUTimeMs` on the asynchronous Workers Trace Events Logpush dataset, while the Tail handler event
schema does not expose CPU time. Logpush reconciliation remains follow-up work and must be complete
before exact CPU-cost claims.

Additional sources checked on 2026-07-21:

- <https://developers.cloudflare.com/dynamic-workers/usage/bindings/>
- <https://developers.cloudflare.com/dynamic-workers/usage/limits/>
- <https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/>
- <https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/>

## Decision

No final runtime primitive is selected yet.

Dynamic Workers remain the preferred candidate for TenantScript Phase 0 because the Loader API
matches version-hash based plugin execution, scoped bindings, and deny-by-default egress. However,
the paid-plan requirement is a real self-host adoption constraint and blocks live latency evidence
in the current account.

## Follow-Up Required

1. Upgrade or use a paid Workers account.
2. Deploy `apps/runtime-bench`.
3. Record `mode=get` warm p95 and `mode=load` cold/create p95 in `docs/benchmarks/phase0.md`.
4. Run the equivalent Workers for Platforms dispatch namespace spike or document why account
   prerequisites prevent it.
5. Change this ADR status to `Accepted` only after the Go/No-Go decision is backed by live data.
