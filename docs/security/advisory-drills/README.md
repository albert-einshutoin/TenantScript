# Security Advisory Drill Evidence

This directory contains sanitized, machine-checked evidence for security response drills. It must never contain reporter identity, credentials, private advisory exports, customer data, production payloads, or unpublished exploit details.

## Completed drills

| Drill                                                   | Kind                      | Scenario                                                       | Severity | Decision              | Result                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TS-DRILL-2026-001](2026-07-20-config-input-crash.json) | public synthetic tabletop | malformed installation config causes an unstructured exception | low      | advisory not required | regression test, structured error fix, threat-model update, CI and review complete in [PR #124](https://github.com/albert-einshutoin/TenantScript/pull/124) |

TS-DRILL-2026-001 replayed the real RED → fix → review timeline from PR #124. It did not create a GitHub private advisory, use an external reporter, exercise embargo communication, or replace the external/community review still required by [Issue #32](https://github.com/albert-einshutoin/TenantScript/issues/32).

## Adding a drill

Follow the [advisory response runbook](../advisory-response-runbook.md), copy the existing JSON structure, use only public synthetic values, and retain one evidence handle for every lifecycle stage. The checker deliberately requires the full lifecycle so a retrospective closeout note cannot be counted as a completed drill.

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:advisory-drills
pnpm test:advisory-drills
```
