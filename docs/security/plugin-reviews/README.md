# Plugin review records

This directory contains sanitized, machine-checked applications of the
[plugin human review checklist](../plugin-review-checklist.md). Each decision is bounded to an
immutable commit and an explicit source scope. It is evidence of a review, not a certification.

| Record                                                        | Target                                     | Baseline                                   | Decision  | Boundary                 |
| ------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | --------- | ------------------------ |
| [`TS-PLUGIN-REVIEW-2026-001`](TS-PLUGIN-REVIEW-2026-001.json) | Built-in `ext init` scaffold and templates | `5c08252f3eb53d0bbdcf5b3b2cff84c038b06831` | `approve` | First-party, accountless |

The checker fails closed when a record has unknown fields, omits one of the five review domains,
references missing evidence, contains secret-like or machine-local data, or approves with a failed
domain, blocker, or required unverified item. The baseline anchors repository context to reachable
history, while complete SHA-256 maps bind every reviewed source and evidence file. Later source or
evidence changes invalidate the decision until a new review is recorded. This remains valid after
either squash or merge commits because the reviewed tree never depends on an intermediate commit.

Run both the schema tests and repository records locally:

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:plugin-reviews
pnpm lint:plugin-reviews
```

Public registry installation and independent review remain separate evidence. Do not change their
status based on this first-party record or on CI success.
