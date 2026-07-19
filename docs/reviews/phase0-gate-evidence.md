# Phase 0 Gate Evidence

Last reconciled: 2026-07-20

This is the canonical public snapshot for the Phase 0 exit gate. A completed row has repository evidence that can be reproduced without maintainer credentials. A blocked row names the external action and open issue; it must not be interpreted as release-ready evidence.

## Gate status

| Gate                          | Status                                           | Public evidence                                                                                                                                                                   | Remaining action                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E2E demo                      | **completed**                                    | [`invoice.created` and `webhook.outbound` E2E](../../apps/example-saas/test/example-saas.e2e.test.ts), plus the [accountless demo guide](../../apps/example-saas/README.md)       | Keep the E2E in Tier 1 as the example contract evolves.                                                                                                                                                                  |
| Runtime latency and ADR-001   | **blocked**                                      | [Local harness and failed paid-plan deploy](../benchmarks/phase0.md); [ADR-001](../adr/001-runtime-primitive.md) remains Blocked                                                  | A maintainer must supply a paid Cloudflare Workers environment, record warm/cold p95, and make the Go/No-Go decision in [#4](https://github.com/albert-einshutoin/TenantScript/issues/4).                                |
| Security suite                | **completed** for the accountless attack surface | [`pnpm test:security` package suites](../security/security-suite-v2.md) cover secret exposure, egress bypass, grant escalation, tenant isolation, approval, and Admin UI handling | Live platform enforcement remains part of the Tier 2 runtime evidence, not a claim of this row.                                                                                                                          |
| Coverage and maintainer PR CI | **completed**                                    | `pnpm verify` enforces package coverage at 80% or higher; [Tier 1](../../.github/workflows/tier1.yml) runs the accountless gate and lockfile scan on pull requests                | Preserve the required `accountless quality gate` branch-protection check.                                                                                                                                                |
| CI / fork PR                  | **blocked** only on independent fork evidence    | The workflow uses no Cloudflare or npm credentials and maintainer PRs pass Tier 1                                                                                                 | An external fork owner must open a harmless PR and retain the run URL in [#2](https://github.com/albert-einshutoin/TenantScript/issues/2). Maintainer-branch success is not a substitute.                                |
| License and public repository | **completed**                                    | [ADR-002](../adr/002-oss-license-and-publication.md), root [`LICENSE`](../../LICENSE), and package metadata establish Apache-2.0 publication                                      | Keep license metadata checks in Tier 1.                                                                                                                                                                                  |
| npm scope                     | **blocked**                                      | Workspace packages and frozen local install work without registry credentials                                                                                                     | A maintainer must authenticate to npm, reserve `@tenantscript`, and record naming evidence in [#3](https://github.com/albert-einshutoin/TenantScript/issues/3).                                                          |
| Design partner                | **blocked** on real candidates and outreach      | The [public profile template](../partners/design-partner-profile-template.md) defines selection and evidence fields without naming companies or people                            | Store company, contact owner, outreach status, and next action in a private maintainer record. Only publish an anonymized or consented case study. No private system was available to verify during this reconciliation. |

## Reproduce accountless evidence

These commands confirm the repository-controlled portion of the gate. They do not produce the missing fork, registry, paid-plan, or partner evidence.

```sh
# cwd: repository root
# expected-exit: 0
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @tenantscript/runtime-bench exec wrangler deploy --config wrangler.jsonc --dry-run
```

## Public and private boundary

The public repository may contain selection criteria, anonymized status totals, consented adopter stories, and reproducible technical evidence. Candidate company names, individual contact details, outreach notes, commercial context, and unannounced pilot dates belong in a private system controlled by maintainers. The private record must retain, at minimum, company/team, contact owner, outreach status, profile match, first-plugin hypothesis, next action, and due date.

Until #2, #3, #4, and the private design-partner record are completed, Phase 0 remains evidence-incomplete even though the accountless product implementation and tests are green.
