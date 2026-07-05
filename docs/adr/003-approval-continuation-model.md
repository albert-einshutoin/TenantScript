# ADR-003: Approval Continuation Model

Date: 2026-07-05
Deciders: TenantScript maintainers
Status: Accepted

## Context

TenantScript plugins can request human approval before continuing side effects (notifications,
outbound calls, etc.). Cloudflare Workers isolates cannot durably suspend mid-execution: a plugin
handler must complete within its declared `timeoutMs`, and there is no supported primitive to park
in-memory state while waiting hours or days for a human decision.

Approval workflows are long-lived. They need notification delivery, reminders, escalation, and
expiry handling that outlive any single handler invocation. Holding a Workers isolate open—or
simulating suspend with in-memory state—would fight platform limits, complicate retries, and blur
the boundary between plugin execution and control-plane lifecycle management.

Product decision [D-011](../Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#3-decision-register)
records this constraint at the product level. Phase 1 approval tasks
[P1-T08](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41),
[P1-T09](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41),
[P1-T10](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41),
[P1-T11](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41),
[P1-T12](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41),
[P1-T13](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41), and
[P1-T41](../../tasks/Phase1.md#チャンク-c-approvalst08t13-t41) implement the model end to end.

## Decision

Use a **continuation hook model** for approvals:

1. When a plugin calls `ctx.approvals.request()`, the runtime creates a durable Approval record
   (role, subject, `resumeHook`, `expiresAt`) and **the handler returns normally**. The handler
   does not suspend and does not block waiting for a human decision.
2. Cloudflare Workflows owns the approval lifecycle: pending state, notifications, reminders,
   escalation, and transition to approved, rejected, or expired.
3. When a decision is recorded, the control plane starts the declared `resumeHook` as a **new
   plugin execution**, passing the decision payload (approved/rejected, subject, etc.).

Plugin authors implement two hooks: an event hook that calls `approvals.request()` and a separate
continuation hook (for example `onInvoiceApprovalDecided`) that runs only after the decision.

Handlers must finish after `approvals.request()` because Workers isolates offer no durable suspend.
The request call registers intent and durable state; waiting for a human inside the same handler
would exceed `timeoutMs`, lose state on retry, and duplicate lifecycle logic that belongs in
Workflows.

## Consequences

**Easier**

- Plugin handlers stay short-lived and align with `timeoutMs` limits; retries do not replay
  suspended in-memory state.
- Approval lifecycle concerns (time, reminders, expiry) live in Workflows, not in untrusted plugin
  code.
- Decision, audit, and authorization boundaries stay explicit: request creates an Approval;
  decision APIs and role checks gate state transitions; continuation runs under a fresh execution
  journal (D-014).

**Harder**

- Plugin authors must split "request approval" and "act on decision" across two handlers instead of
  linear async/await after a suspend point.
- Continuation hooks need manifest declaration, capability grants, and tests that cover the
  request → decision → continuation path (P1-T11).

**Deferred**

- No durable suspend API for plugins; any future "wait for external event" patterns must also use
  continuation or out-of-band resumption, not in-handler blocking.
