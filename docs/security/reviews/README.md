# Security Review Campaigns

This directory contains public, machine-checked metadata for bounded community security reviews. It must contain only sanitized evidence; suspected vulnerabilities belong in [Private Vulnerability Reporting](https://github.com/albert-einshutoin/TenantScript/security/advisories/new).

| Campaign                                        | Baseline                                   | Status     | Reviewer | Completion claim |
| ----------------------------------------------- | ------------------------------------------ | ---------- | -------- | ---------------- |
| [`TS-REVIEW-2026-001`](TS-REVIEW-2026-001.json) | `c906cf2465b16bc5032e544d07ee0588bac40028` | `prepared` | none     | not complete     |

The review scope, method, reporting route, and evidence contract are in the [community review packet](../community-review-packet.md).

## Lifecycle

1. `prepared`: scope and immutable baseline are published; reviewers, coverage, and attestations remain empty.
2. `in-progress`: at least one reviewer and an independence statement are recorded; sanitized partial evidence may be added.
3. `completed`: every required focus has evidence, the final attestation exists, and every critical or high finding is resolved with a regression test.

Do not edit `status` to imply progress or completion before the corresponding evidence exists. A maintainer's self-review does not count as independent review, and CI success does not certify the implementation.

Run the contract locally with:

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:security-reviews
```
