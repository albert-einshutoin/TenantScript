# Plugin review records

This directory contains sanitized, machine-checked applications of the
[plugin human review checklist](../plugin-review-checklist.md). Each decision is bounded to an
immutable commit and an explicit source scope. It is evidence of a review, not a certification.

| Record                                                        | Target                       | Baseline                                   | Decision  | Boundary                 |
| ------------------------------------------------------------- | ---------------------------- | ------------------------------------------ | --------- | ------------------------ |
| [`TS-PLUGIN-REVIEW-2026-001`](TS-PLUGIN-REVIEW-2026-001.json) | Built-in `ext init` scaffold | `f2140cfc18ee844c01745781af63d16a77c951d3` | `approve` | First-party, accountless |

The checker fails closed when a record has unknown fields, omits one of the five review domains,
references missing evidence, contains secret-like or machine-local data, or approves with a failed
domain, blocker, or required unverified item. It also compares the reviewed source with the pinned
baseline; a later source change invalidates the decision until a new review is recorded.

Run both the schema tests and repository records locally:

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:plugin-reviews
pnpm lint:plugin-reviews
```

Public registry installation and independent review remain separate evidence. Do not change their
status based on this first-party record or on CI success.
