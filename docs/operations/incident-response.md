# Incident response runbook

This runbook covers repository-controlled response paths for runaway plugins, capability or broker
failures, budget incidents, and D1/R2 availability failures. It is an operational contract for
self-hosters, not a claim that a particular deployment has completed a live disaster-recovery
exercise.

## Safety and ownership

The on-call operator owns detection and containment. An application owner or administrator owns an
installation disable, rollback, or recovery decision. A security maintainer must join when there is
possible tenant-boundary, credential, or confidentiality impact. Record only redacted execution
status, timestamps, versions, and repository/public evidence. Never copy payloads, configuration,
grants, credentials, customer identifiers, provider responses, or stack traces into a public drill,
issue, or pull request.

Classify impact before changing state:

| Severity | Example                                                                       | Response target                                                  |
| -------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Critical | suspected cross-tenant access or credential exposure                          | contain immediately and use the private process in `SECURITY.md` |
| High     | repeated policy failure, widespread plugin quarantine, or sustained D1 outage | assign owner and contain before recovery                         |
| Medium   | one installation or non-critical capability degraded                          | bound impact and restore with explicit approval                  |
| Low      | synthetic or no-user-impact anomaly                                           | document and fix through normal GitHub Flow                      |

## Required lifecycle

### 1. Detect

Confirm the signal using bounded evidence: execution status trends, quarantine notifications,
budget-disable state, mutation/search errors, or a reproducible accountless chaos test. Timestamp
the start and appoint an incident owner. Treat a missing notification as inconclusive because the
notification sink can fail after a durable quarantine transition.

### 2. Scope

Identify the affected app, tenant scope, installation, plugin version, hook type, capability, and
storage dependency without exporting customer data. Determine whether the failure is:

- plugin CPU, memory, recursion, or repeated execution failure;
- provider or capability broker unavailability;
- budget exhaustion;
- D1 mutation/read unavailability; or
- R2 archive write/search unavailability.

Check whether policy hooks are denying, transform hooks are skipping, and event hooks are retrying
then failing open as designed. If behavior crosses a tenant or grant boundary, stop public
discussion and use the private security response process.

### 3. Contain

Choose the smallest safe action and preserve audit evidence:

- **Runaway plugin:** keep the installation quarantined or explicitly disable it. Do not increase
  runtime limits to hide CPU or memory exhaustion. Roll back to a known-good version when its
  compatibility and grants are understood.
- **Capability or broker failure:** do not bypass the broker or expose credentials. Policy hooks
  fail closed, transform hooks skip the transformation, and event hooks exhaust their bounded
  retry policy before failing open. Disable only the affected installation when the provider outage
  makes continued attempts unsafe.
- **Budget incident:** keep the budget guard's durable disable state. Confirm the UTC period and
  usage evidence before an authenticated owner/admin re-enables execution; never mutate counters
  manually to force recovery.
- **D1 outage:** fail closed for state-dependent reads and mutations. Do not invent in-memory
  authorization, quarantine, migration, or idempotency state.
- **R2 outage:** preserve D1 hot data when archive writes fail. Fail closed for archive searches
  that cannot provide complete results; do not present partial history as complete.

### 4. Recover

Fix the plugin, provider, configuration, or storage dependency before re-enabling work. For runaway
plugins, follow [Runaway installation quarantine](runaway-quarantine.md), perform explicit atomic
recovery, run one synthetic hook, and monitor the first executions. For a rollback, follow
[Rollback troubleshooting](rollback-troubleshooting.md). Reconcile durable quarantine or budget
state with the notification sink so a delivery failure does not erase the operational event.

Recovery is complete only when the intended hook behavior and durable state are verified. External
provider health alone is not proof of TenantScript recovery.

### 5. Postmortem

Record the sanitized timeline, root cause, containment decision, recovery evidence, and remaining
limitations. Add or strengthen a failing regression/chaos test before the implementation fix when
the repository controls the behavior. Track external-account evidence separately instead of
inventing thresholds or production results.

## Drill contract

Public drill records live in `docs/operations/incident-drills/` and must be synthetic tabletop
records. The checker requires the exact detect → scope → contain → recover → postmortem lifecycle,
chronological timestamps, repository-contained or public HTTPS evidence, a declared outcome, and
at least one remaining limitation. It rejects credential-shaped fields and values.

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:incident-drills
pnpm test:incident-drills
pnpm test:chaos
```

The committed drill proves the accountless operational contract. It does not exercise a live
Cloudflare deployment, paid-plan runtime enforcement, external provider communication, or actual
customer traffic.
