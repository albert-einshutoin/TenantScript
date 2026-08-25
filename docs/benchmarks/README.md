# Benchmarks

Version gate evidence and legacy operator drill results for TenantScript.

## Index

| Version | Topic            | Status                                                                                              | Doc                                                     |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| v0.2    | Runtime latency  | **blocked** — live measurements require a Cloudflare paid Workers plan (see [phase0.md](phase0.md)) | [v0.2 Live Edge runtime latency](phase0.md)             |
| v0.3    | Rollback fixture | **not partner evidence** — repository fixture only; qualified partner evidence is not recorded      | [v0.3 rollback drill fixture](phase1-rollback-drill.md) |

## v0.2 Live Edge runtime latency

Live latency evidence is **blocked** on the Cloudflare paid Workers plan. The harness and local validation are documented in [phase0.md](phase0.md); the recorded deploy attempt failed with Cloudflare API code 10195 until that blocker is removed.

## v0.3 rollback drill fixture

The operator rollback path and MTTR calculation fixture are documented in [phase1-rollback-drill.md](phase1-rollback-drill.md). This fixture validates timestamp calculation only; it does not provide qualified design-partner or production evidence and does not close the v0.3 gate.
Regenerate the sample result from a repository checkout with the package script wrapper:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli run rollback:drill -- \
  --deployed-at 2026-06-13T00:00:00.000Z \
  --detected-at 2026-06-13T00:01:15.000Z \
  --rollback-started-at 2026-06-13T00:02:00.000Z \
  --completed-at 2026-06-13T00:03:20.000Z
```

The installed product CLI spells the same operation `ext rollback-drill`; `rollback:drill` is only
the pnpm script name used inside this repository.

## How to add a benchmark

When you add a new benchmark document, update this README index and include the following in the benchmark doc.

### Required fields

| Field                   | Where         | Notes                                                                                                               |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **version**             | Index table   | Version gate (e.g. `v0.2`, `v0.3`).                                                                                 |
| **topic**               | Index table   | Short label for the measurement (e.g. `Runtime latency`).                                                           |
| **status**              | Index table   | One of `completed`, `blocked`, or `in progress`. If blocked, state the blocker (e.g. Cloudflare paid Workers plan). |
| **doc link**            | Index table   | Link to the benchmark markdown file in `docs/benchmarks/`.                                                          |
| **measurement command** | Benchmark doc | Copy-pasteable `sh` command that reproduces the measurement. Use repo scripts and local fixtures only.              |
| **result shape**        | Benchmark doc | Fenced output (text or JSON) showing what a successful run produces.                                                |
| **Go/No-Go decision**   | Benchmark doc | Thresholds and pass/fail decision where a phase gate applies; omit only when no gate exists yet.                    |

### Evidence expectations

- Commands must be rerunnable from a clean checkout without live provider credentials, API tokens, account IDs, or real tenant/customer data.
- Record blockers explicitly (for example, live Cloudflare measurements blocked on the paid Workers plan) instead of omitting status.
- Local validation commands (typecheck, lint, dry-run deploy) are acceptable evidence when live measurement is blocked.

### Verification

After updating the index and benchmark doc, confirm the new row appears in the table above and the linked doc contains all required fields:

```sh
# cwd: repository root
# expected-exit: 0
rg -n "Phase|Topic|Status|measurement|Result|Go/No-Go|Decision" docs/benchmarks/
```
