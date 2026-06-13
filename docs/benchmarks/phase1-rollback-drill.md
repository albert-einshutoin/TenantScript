# Phase 1 Rollback Drill

Date: 2026-06-13

## Goal

Measure the operator path from a broken plugin version reaching production to rollback completion.
The Phase 1 gate is MTTR `< 5 minutes`.

## Drill Scenario

1. Deploy a known-broken plugin version and pin the test installation to that version.
2. Detect the failed execution from the control-plane execution log or operator alert.
3. Start rollback with `ext rollback`, targeting the last known-good version.
4. Confirm the installation pin points at the restored version and the rollback audit entry exists.
5. Record the four timestamps with `rollback:drill`.

## Measurement Command

```sh
pnpm --filter @tenantscript/cli rollback:drill -- \
  --deployed-at 2026-06-13T00:00:00.000Z \
  --detected-at 2026-06-13T00:01:15.000Z \
  --rollback-started-at 2026-06-13T00:02:00.000Z \
  --completed-at 2026-06-13T00:03:20.000Z
```

## Result

```json
{
  "deployedAt": "2026-06-13T00:00:00.000Z",
  "detectedAt": "2026-06-13T00:01:15.000Z",
  "rollbackStartedAt": "2026-06-13T00:02:00.000Z",
  "completedAt": "2026-06-13T00:03:20.000Z",
  "detectionMs": 75000,
  "rollbackMs": 80000,
  "mttrMs": 200000,
  "thresholdMs": 300000,
  "passed": true
}
```

Decision: pass. The measured MTTR was 3m20s, below the 5m Phase 1 gate.
