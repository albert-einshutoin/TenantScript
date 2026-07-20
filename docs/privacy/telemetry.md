# Opt-in telemetry and privacy

TenantScript telemetry is **off by default**. A self-hosted deployment performs no telemetry D1
query and makes no telemetry network request unless its operator explicitly sets
`TENANTSCRIPT_TELEMETRY_ENABLED=true` together with every required setting below. TenantScript does
not configure a default collector.

## Configuration

| Binding                           | Disabled default | Required when enabled | Contract                                                            |
| --------------------------------- | ---------------- | --------------------- | ------------------------------------------------------------------- |
| `TENANTSCRIPT_TELEMETRY_ENABLED`  | unset or `false` | yes                   | only the exact value `true` opts in                                 |
| `TENANTSCRIPT_TELEMETRY_ENDPOINT` | unset            | yes                   | public HTTPS URL without credentials, query, or fragment            |
| `TENANTSCRIPT_PRODUCT_VERSION`    | unset            | yes                   | semantic version of the running deployment                          |
| `TENANTSCRIPT_RUNTIME_PRIMITIVE`  | unset            | yes                   | `cloudflare-workers`, `dynamic-workers`, or `workers-for-platforms` |

The Control Plane Worker exports a scheduled handler. Operators who opt in must configure their own
Cron Trigger and receiver endpoint. Each scheduled invocation reads one aggregate-only D1 statement
and posts one JSON event. Disabling the flag stops both the aggregate read and request on the next
deployment. Invalid enabled configuration fails without reflecting endpoint details in the Admin
API.

The Admin UI shows `Anonymous telemetry On` or `Off`. It never receives or renders the receiver
endpoint.

## Exact event schema

The machine-readable source of truth is
[`telemetry-event.schema.json`](../reference/telemetry-event.schema.json). Version 1 contains only:

- event generation time;
- TenantScript semantic version;
- runtime primitive category;
- total enabled installation and execution counts for the self-hosted deployment; and
- aggregate counts for runtime error, timeout, egress denial, and budget-exceeded categories.

Every object is closed with `additionalProperties: false`. The sender reconstructs the exact event
before serialization, so structurally attached fields cannot cross the sink boundary.

## Data that is never sent

Telemetry does not contain a persistent deployment identifier, IP address field, app or tenant ID,
tenant/customer/company name, plugin ID or name, hook name, payload, configuration, capability
input/result, grant, credential, token, secret, provider response, error text, stack trace, audit
record, database row, or machine-local path. The sender sets no Authorization header, refuses
redirects, and never reads or reflects a rejected receiver response body.

The receiver can still observe ordinary connection metadata such as source IP and request time.
Operators must review their chosen receiver's retention and access policy before enabling telemetry.
For stronger privacy, keep telemetry disabled or use an operator-controlled aggregation proxy.

## Failure and verification contract

Telemetry runs only in the scheduled path and is not execution authority. A receiver or telemetry
query failure must never change plugin execution, authorization, budget, rollback, or audit state.
The scheduled run reports its own failure for operator monitoring.

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane test -- test/telemetry.test.ts
pnpm test:telemetry-contract
pnpm test:security
```

Changes to the event require a schema version decision, privacy review, adversarial test update,
this document, and the Admin UI status contract in the same pull request.
