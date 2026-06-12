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
