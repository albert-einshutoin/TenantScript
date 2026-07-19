# Installation grant approval

`POST /v1/admin/installation-requests` separates an operator's installation proposal from the
privileged action that makes capability grants live. The Control Plane validates the plugin
version, configuration schema, capability confirmation, and resolved grant scopes before it
creates a pending approval. No installation exists until an authorized approver accepts that exact
normalized proposal.

## Role contract

- `operator` can read the install preview and submit a request, but cannot call the immediate
  installation, approval-decision, rollback, or installation-command routes.
- `owner`, `admin`, `tenant-admin`, and the legacy `manager` alias can approve an installation
  grant inside the app and tenant scope carried by their authenticated identity.
- `viewer`, `operator`, unknown roles, expired approvals, duplicate decisions, and cross-tenant or
  cross-app subjects fail closed in both the HTTP authorization layer and the D1 decision trigger.
- `owner`, `admin`, and `tenant-admin` may still use the immediate installation route when the
  operational policy does not require separation of duties.

Clients must send the same validated installation body used by the immediate install route and a
16–128 character `Idempotency-Key`. Repeating the same tenant-scoped request returns the original
pending approval. Reusing the key for a different proposal returns `409 idempotency_key_reused`.
The request result contains only the approval id, plugin/version identifiers, capability names,
state, and expiry; it never echoes configuration or resolved grant values.

## Atomic state transitions

Request creation stores the pending approval, normalized configuration and grants, safe capability
audit metadata, and the 24-hour idempotency record in one D1 batch. The approval queue shows role
`admin` and resume hook `installation.request`.

Approval reads the stored proposal through its app, tenant, plugin, and version joins. A single D1
batch then creates the installation, writes the redacted installation audit event, and inserts the
approval audit event whose trigger performs the approval state transition. Any conflict rolls back
the complete batch, so a grant cannot become live without one successful approval decision.
Rejection changes only the approval state and audit trail; it never creates an installation.

## Deployment and recovery

Apply migrations before deploying the Worker and Admin UI:

1. `0009_installation_grant_requests.sql` creates scoped request, audit, and idempotency storage.
2. `0010_admin_approval_threshold.sql` updates the D1 decision trigger so canonical admin-capable
   roles can satisfy the grant-approval threshold while operator and viewer remain denied.
3. Deploy the Control Plane Worker, then the Admin UI.

Do not deploy a Worker that exposes the request route before migration `0009` is applied. If a
deployment must be rolled back, keep both migrations in place: they are additive and remain
compatible with the prior Worker. Pending requests may be rejected normally or allowed to expire;
do not edit their stored config or grant JSON manually. Diagnose a failed approval by correlating
the approval id with `installation_request_audit_events`, `approval_audit_events`, and
`admin_audit_events` without logging the stored configuration or grant payloads.
