# Benchmarks

Phase gate evidence and operator drill results for TenantScript.

## Index

| Phase | Topic | Status | Doc |
| --- | --- | --- | --- |
| 0 | Runtime latency | **blocked** — live measurements require a Cloudflare paid Workers plan (see [phase0.md](phase0.md)) | [Phase 0 runtime latency](phase0.md) |
| 1 | Rollback drill | completed | [Phase 1 rollback drill](phase1-rollback-drill.md) |

## Phase 0 runtime latency

Live latency evidence is **blocked** on the Cloudflare paid Workers plan. The harness and local validation are documented in [phase0.md](phase0.md); the recorded deploy attempt failed with Cloudflare API code 10195 until that blocker is removed.

## Phase 1 rollback drill

Operator rollback path and MTTR measurement are documented in [phase1-rollback-drill.md](phase1-rollback-drill.md).
