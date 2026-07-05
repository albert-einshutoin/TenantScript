# Benchmarks

Phase gate evidence and operator drill results for TenantScript.

## Index

| Phase | Topic           | Status                                                                                              | Doc                                                |
| ----- | --------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 0     | Runtime latency | **blocked** — live measurements require a Cloudflare paid Workers plan (see [phase0.md](phase0.md)) | [Phase 0 runtime latency](phase0.md)               |
| 1     | Rollback drill  | completed                                                                                           | [Phase 1 rollback drill](phase1-rollback-drill.md) |

## Phase 0 runtime latency

Live latency evidence is **blocked** on the Cloudflare paid Workers plan. The harness and local validation are documented in [phase0.md](phase0.md); the recorded deploy attempt failed with Cloudflare API code 10195 until that blocker is removed.

## Phase 1 rollback drill

Operator rollback path and MTTR measurement are documented in [phase1-rollback-drill.md](phase1-rollback-drill.md).

## How to add a benchmark

When you add a new benchmark document, update this README index and include the following in the benchmark doc.

### Required fields

| Field                   | Where         | Notes                                                                                                               |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| **phase**               | Index table   | Gate phase number (e.g. `0`, `1`).                                                                                  |
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
rg -n "Phase|Topic|Status|measurement|Result|Go/No-Go|Decision" docs/benchmarks/
```
