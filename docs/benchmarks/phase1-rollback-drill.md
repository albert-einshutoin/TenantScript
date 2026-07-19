# Phase 1 Rollback Drill

Date: 2026-06-13

## Goal

Measure the operator path from a broken plugin version reaching production to rollback completion.
The Phase 1 gate is MTTR `< 5 minutes`.

## Drill Scenario

1. Deploy a known-broken plugin version and pin the test installation to that version.
2. Detect the failed execution from the control-plane execution log or operator alert.
3. Open Admin UI **Versions**, choose the last known-good version, and record `rollbackStartedAt`
   immediately before **Confirm rollback**. The CLI `ext rollback` remains the fallback path.
4. Wait for **Rollback completed**. Record the displayed audit ID, server completion timestamp, and
   UI rollback duration; then use **View execution log** to confirm the next execution used the
   restored version.
5. Record the four timestamps with the public CLI subcommand `ext rollback-drill` or the repository
   wrapper shown below.

The manager confirmation must show the tenant, plugin, current version, and target version. Viewer
tokens must not show rollback controls and receive `403` from the direct API.

## Measurement Command

Installed CLI users run `ext rollback-drill <options>`. From a TenantScript checkout, use the pnpm
script wrapper below; `rollback:drill` is a package script name, not an `ext` subcommand.

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli run rollback:drill -- \
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

## Admin UI Evidence Record

Store one JSON record per drill beside this document (do not include tokens, config, grants, or
customer payloads):

```json
{
  "mode": "admin-ui",
  "tenantId": "tenant_redacted_or_test_fixture",
  "installationId": "installation_test",
  "pluginKey": "invoice-notify",
  "fromVersion": "1.3.0-broken",
  "toVersion": "1.2.2",
  "deployedAt": "2026-07-19T16:55:00.000Z",
  "detectedAt": "2026-07-19T16:56:15.000Z",
  "rollbackStartedAt": "2026-07-19T16:57:00.000Z",
  "completedAt": "2026-07-19T16:58:20.000Z",
  "auditId": "audit_rollback_fixture",
  "verificationExecutionId": "execution_fixture",
  "uiRollbackMs": 80000,
  "mttrMs": 200000,
  "thresholdMs": 300000,
  "passed": true
}
```

`completedAt` and `auditId` come from the Control Plane response. `verificationExecutionId` is the
first post-rollback execution using `toVersion`. The public `ext rollback-drill` subcommand and the
repository `rollback:drill` script wrapper use the same timestamp validator and gate computation.
