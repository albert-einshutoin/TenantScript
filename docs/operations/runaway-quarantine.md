# Runaway installation quarantine

TenantScript can automatically disable an installation after repeated execution failures or
timeouts. The guard is an internal host-runtime contract: it is not a public unauthenticated HTTP
endpoint, and callers must supply the installation selected by the trusted execution planner.

## Integration contract

After the execution record is durably written, call `enforceRunawayPolicyAfterExecution` with the
same installation, tenant, plugin, outcome, and completion time. Map successful completion to
`success`, handler or broker failure to `error`, and loader timeout to `timeout`. Budget rejection is
handled by the separate budget guard and must not increment runaway counters.

Every host must configure positive integer `consecutiveFailures` and `consecutiveTimeouts`
thresholds from observed workload behavior. TenantScript intentionally has no guessed production
default: an arbitrary threshold can quarantine healthy plugins during a provider incident.

The D1 store persists consecutive counters by installation. A success resets active failure and
timeout counters. An error increments consecutive failures and resets consecutive timeouts. A
timeout increments both counters. Disabled installations remain quarantined until explicit
recovery; an in-flight success cannot re-enable one.

## Quarantine behavior

When either threshold is reached, the D1 migration trigger changes the installation from enabled to
disabled in the same SQLite statement that records the quarantine transition. Concurrent execution
completions can therefore produce only one transition and one `installation.quarantined`
notification. The event contains installation, tenant, and plugin identifiers, fixed reason and
counter fields, and a timestamp; it never contains payloads, configuration, grants, secrets, stack
traces, or provider error text.

The notification sink should be a durable host-owned queue. If publishing fails, the guard rejects
but leaves the installation disabled. Operators must alert on sink failures and reconcile persisted
quarantine rows before assuming every notification was delivered.

## Recovery

1. Confirm the installation is disabled and inspect redacted execution status trends.
2. Fix or roll back the plugin/provider problem. Do not recover solely to silence an alert.
3. Review the configured thresholds against observed traffic and timeout behavior.
4. From an authenticated owner/admin operation, call `recoverRunawayInstallation` with the affected
   installation ID.
5. Confirm counters and quarantine reason are cleared and the installation is enabled.
6. Run a synthetic hook and monitor the first executions for renewed failures.

Recovery fails closed when no persisted quarantine exists. The D1 recovery transition resets
counters and re-enables the installation atomically, preventing stale counters from immediately
re-triggering quarantine.

## Verification evidence

- Policy and notification behavior:
  `packages/control-plane/test/runaway-guard.test.ts`
- D1 quarantine/recovery triggers and concurrent transition behavior:
  `packages/control-plane/test/runaway-guard.workers.test.ts`

These accountless tests run in Tier 1. Live provider incidents, Cloudflare load thresholds, and the
broader chaos drill remain separate work in Issue #23.
