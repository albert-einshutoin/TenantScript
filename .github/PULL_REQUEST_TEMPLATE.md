## Why

<!-- Explain the adopter or contributor problem and why this change belongs in TenantScript now. -->

Fixes #

## Before / after

<!-- Describe the previous behavior and the observable behavior after this PR. -->

## Scope and decisions

<!-- List the packages or docs changed, important decisions, and intentionally excluded work. Link an ADR when the change affects architecture. -->

## TDD and self-review

- [ ] **RED**: I added or identified a failing behavior test or an explicit verification checklist before implementation.
- [ ] **GREEN**: I implemented the complete issue contract and confirmed the focused check passes.
- [ ] **REFACTOR**: I reviewed naming, duplication, package boundaries, error handling, and non-obvious rationale.
- [ ] The PR is focused on one issue and contains no unrelated changes.
- [ ] I reviewed the final diff and resolved every actionable review thread.

## Security and compatibility

<!-- State which tenant, identity, capability, egress, audit, persistence, or supply-chain boundaries are affected. Write "No boundary change" with a reason when none are affected. -->

- [ ] I assessed the security impact and added adversarial tests where a boundary changes.
- [ ] I assessed public API, manifest/schema, storage, and operational compatibility.
- [ ] Logs, errors, fixtures, screenshots, and documentation use synthetic or redacted data.

## Verification

### Tier 1 — accountless

<!-- Paste the exact commands and concise results. Remove commands that genuinely do not apply and explain why. -->

```text
pnpm verify
pnpm test:security
pnpm test:coverage
pnpm audit --audit-level high
git diff --check
```

- [ ] Required Tier 1 checks pass.
- [ ] Package coverage remains at or above the project threshold, or the impact is explained.

### Tier 2 — live

- [ ] Not required: the issue can be proven by Tier 1 evidence.
- [ ] Required: the issue or ADR explicitly requires live validation, and the result is linked below.
- [ ] Pending external validation: the unverified claim and blocker are stated below and this PR does not mark them complete.

Tier 2 evidence or rationale:

<!-- Link the run or benchmark record. Do not paste environment-specific values. -->

## Documentation and operations

- [ ] Contributor or operator documentation is updated, or no documentation change is needed.
- [ ] Migration, rollback, observability, and release impact are documented where applicable.
- [ ] Remaining manual or external verification is explicit and separate from implemented behavior.
