# Community Security Review Packet

- Campaign: `TS-REVIEW-2026-001`
- Baseline commit: `c906cf2465b16bc5032e544d07ee0588bac40028`
- Status: **prepared — no independent reviewer has started, and this review is not complete**

This packet gives an independent reviewer a bounded, reproducible way to review TenantScript's security architecture. It is an invitation and review contract, not an audit report or certification. The immutable baseline prevents later code from inheriting conclusions that were reached for different code.

## Goal and scope

The goal is to identify boundary failures that could expose secrets, escape a plugin's authority, cross an app or tenant boundary, or grant unintended administrator authority. Review these repository paths at the pinned commit:

- `packages/loader`
- `packages/capabilities`
- `packages/proxy`
- `packages/control-plane`
- `apps/admin-ui`
- `packages/manifest`
- `packages/host-sdk`
- `docs/security/threat-model.md`

The review must cover all six focus areas below. A reviewer may add areas, but cannot omit one and still mark the campaign complete.

### Loader isolation

Assess ambient globals, raw egress denial, execution timeout, subrequest budgets, bundle validation, and whether tenant code can obtain process state, bindings, or credentials. Start with `packages/loader/src` and `packages/loader/test/security-suite.test.ts`.

### Capability broker

Assess installation-grant resolution, capability/channel/role checks, tenant binding, journal replay integrity, secret handling, and provider-adapter authority. Start with `packages/capabilities/src` and `packages/capabilities/test/security-suite.test.ts`.

### Egress and proxy

Assess URL parsing, public-address enforcement, redirect behavior, origin allowlisting, credential forwarding, DNS/encoding ambiguity, and failure defaults. Start with `packages/proxy/src` and `packages/proxy/test/security-suite.test.ts`.

### Identity and RBAC

Assess authenticated identity derivation, app/tenant binding, approval and rollback authority, service-token behavior, and denial defaults. Start with `packages/control-plane/src` and `packages/control-plane/test/security-suite.test.ts`.

### Storage isolation

Assess D1, R2, and Durable Object predicates and keys for cross-app or cross-tenant access, concurrent updates, audit integrity, cursor scope, and idempotency. Include `packages/control-plane/test/security-suite.workers.test.ts`.

### Admin UI

Assess bearer-token use, cookie/credential behavior, XSS-safe rendering, mutation authorization, untrusted labels and URLs, and whether the UI implies authority the API does not grant. Start with `apps/admin-ui/src` and `apps/admin-ui/src/security-suite.test.tsx`.

## Known limitations to preserve as findings context

Do not report these tracked gaps as newly discovered unless the implementation creates an additional exploit path:

- Phase 3 envelope encryption and rotation are tracked in [Issue #31](https://github.com/albert-einshutoin/TenantScript/issues/31).
- Scoped RBAC and revocable service tokens are tracked in [Issue #24](https://github.com/albert-einshutoin/TenantScript/issues/24).
- Paid Cloudflare Workers live evidence is blocked and tracked in [Issue #4](https://github.com/albert-einshutoin/TenantScript/issues/4).

These limitations remain security-relevant. Their existence must not be used to waive a distinct boundary failure.

## Review method

1. Check out the exact baseline commit and verify its hash.
2. Read the [threat model](threat-model.md), relevant ADRs, implementation, and permanent security tests.
3. Trace untrusted inputs to each enforcement point and attempt to falsify the documented guarantee.
4. Add adversarial tests with synthetic data for suspected failures. Do not use real credentials, tenant data, production accounts, or destructive live testing.
5. Run the accountless verification commands below and record sanitized, durable evidence for every focus area.
6. Submit vulnerabilities privately; publish only non-sensitive coverage evidence and resolved-finding references.

```sh
# cwd: repository root
# expected-exit: 0
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm test:security
pnpm test:fuzz
pnpm verify
```

Live or destructive testing is outside this campaign. Obtain explicit maintainer authorization before interacting with any hosted deployment or third-party account.

## Reporting and evidence

Report suspected vulnerabilities through GitHub [Private Vulnerability Reporting](https://github.com/albert-einshutoin/TenantScript/security/advisories/new). Do not place exploit details, private report URLs, credentials, or tenant information in campaign JSON, issues, pull requests, or logs.

Non-sensitive coverage attestations may be posted to [Issue #32](https://github.com/albert-einshutoin/TenantScript/issues/32). Durable evidence may be a repository-relative file or a public HTTPS URL without credentials, query parameters, or fragments.

For each finding record:

- ID in the form `TS-FINDING-NNN`;
- severity: `critical`, `high`, `medium`, or `low`;
- status: `open`, `resolved`, or `accepted-risk`;
- sanitized evidence reference;
- a permanent regression-test reference when a critical or high finding is resolved.

## Independence and completion contract

An independent reviewer must not be the author of the reviewed implementation and must disclose relevant conflicts of interest. Maintainer self-review and automated tests are valuable gates, but do not satisfy this campaign's independent-review requirement.

The campaign may change from `prepared` to `in-progress` only after a reviewer is named, supplies an independence statement, and records a start time. It may change to `completed` only when:

- the review remains pinned to the exact baseline commit;
- every required focus area has `reviewed` coverage and sanitized evidence;
- a final attestation is recorded;
- no critical or high finding remains open or accepted as risk;
- every resolved critical or high finding links a permanent regression test;
- completion time follows the start time; and
- `pnpm lint:security-reviews` and the repository quality gates pass.

The machine-readable record lives in [`reviews/TS-REVIEW-2026-001.json`](reviews/TS-REVIEW-2026-001.json). The checker intentionally rejects incomplete evidence presented as a completed review.
