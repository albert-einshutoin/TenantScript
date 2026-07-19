# Audit integrity

TenantScript's Phase 2 audit boundary is append-only and independently verifiable. It is designed
to make accidental mutation fail closed and to make forged, missing, or reordered evidence
detectable without trusting the database row order alone.

## Storage contract

`audit_events` is the canonical hash-chained evidence store. Each chain is isolated by
`tenant_id` and `app_id`; sequence 1 starts from 64 zeroes, and every later event commits to the
previous event hash. `createD1AuditLogStore()` exposes only `append`, `list`, and verification
operations. It intentionally has no update or delete method.

The D1 migration also rejects `UPDATE` and `DELETE` for these tables:

- `audit_events`
- `admin_audit_events`
- `approval_audit_events`
- `installation_request_audit_events`

Existing specialized tables remain available while their producers migrate to the canonical
event vocabulary. Their rows are write-once immediately; new cross-cutting audit producers should
append the corresponding metadata-only event to `audit_events` through the shared store.

## Why the chain head is mutable

`audit_chain_heads` is coordination state, not evidence. The event insert trigger compares the
submitted sequence and previous hash with that head, then advances the head in the same D1
transaction. This prevents concurrent writers from creating two accepted branches. A writer that
loses the race re-reads the head and recomputes its event hash.

The SHA-256 input is deterministic canonical JSON containing the event scope, sequence, category,
action, trusted actor, resource reference, metadata payload, previous hash, and timestamp. The
verifier recalculates every hash and rejects sequence gaps, predecessor mismatch, and payload or
header mutation.

## Data minimization

Audit payloads are compliance metadata, not a copy of business data. Producers must never include:

- access tokens, credentials, secret references, or authorization headers;
- installation configuration or grant values;
- raw hook payloads, customer records, or approval subjects;
- stack traces that can contain request data.

Prefer stable IDs, action names, capability names, result categories, revisions, and hashes. Actor
values must come from the authenticated identity boundary, not request-body claims.

## Verification and incident response

Run the accountless attack suite before release:

```sh
pnpm test:security
```

At runtime, call `verify({ tenantId, appId })` before exporting or archiving a chain. A failed
verification is an integrity incident: stop export/retention processing for that scope, preserve a
read-only database snapshot and Worker logs, record the first failing sequence, and rotate any
credential that could write to the control-plane database. Do not repair or delete the suspect
row in place.

R2 retention and signed NDJSON export are separate P2-T10 and P2-T11 boundaries. They must preserve
the event hashes and manifest the exported range rather than weakening this write-once contract.
