# Security Policy

TenantScript executes tenant-scoped extensions and brokers privileged capabilities. We appreciate coordinated reports that help protect adopters and their users.

## Supported versions

TenantScript is pre-v1 and does not publish supported release lines yet.

| Version                                       | Supported |
| --------------------------------------------- | --------- |
| Latest commit on `main`                       | Yes       |
| Older commits, forks, and unreleased branches | No        |

Security fixes are developed against `main`. Once versioned releases exist, this table will identify the maintained release lines and their end-of-support dates.

## Report a vulnerability privately

Use [GitHub Security Advisories through Private Vulnerability Reporting](https://github.com/albert-einshutoin/TenantScript/security/advisories/new) for suspected vulnerabilities. Do not open a public issue, discussion, or pull request before maintainers have coordinated disclosure.

Maintainers follow the [security advisory response runbook](docs/security/advisory-response-runbook.md) for intake, triage, regression testing, private fixes, advisory decisions, and sanitized closeout evidence.

Include only the minimum information needed to reproduce and assess the problem:

- affected component and commit or version;
- security impact and the boundary that can be crossed;
- minimal reproduction steps using synthetic data;
- relevant configuration with secrets redacted;
- any known workaround.

Never include real credentials, API tokens, tenant data, customer payloads, production account IDs, database dumps, or unredacted exploit payloads in public channels. The private advisory should also use synthetic data whenever possible.

## Response and triage SLA

These are response targets, not a guarantee that every report can be fixed within the same period:

- Initial acknowledgement: within 3 business days.
- Initial severity and scope triage: within 7 business days.
- Remediation and disclosure plan: shared after impact, exploitability, and adopter risk are understood.

If a target will be missed, maintainers will update the private advisory with the current status and next expected update. Fix timing depends on severity, compatibility risk, and the availability of a safe regression test.

## Coordinated disclosure

Maintainers will validate the report, agree on severity and affected versions, develop a regression test and fix, and prepare an advisory. Please allow time for downstream self-hosted adopters to update before publishing technical details. We will credit reporters who request attribution, unless legal or safety constraints prevent it.

Reports about leaked third-party credentials should also follow the provider's revocation process immediately. Do not wait for a TenantScript code fix before rotating an exposed credential.

## Security scope

The supported attack surface includes the loader, capability broker, control-plane API, proxy, CLI, and documentation examples maintained in this repository. Reports are in scope when behavior in one of these components could weaken an adopter's security boundary, even if the affected path is not enabled by default.

Examples include tenant-boundary bypass, capability grant escalation, secret exposure, egress allowlist bypass, rollback or approval authorization bypass, audit tampering, unsafe copy-paste guidance, and supply-chain compromise in this repository.

General support questions, deployment mistakes without a security boundary failure, and vulnerabilities that only affect unsupported forks should use normal project discussions after removing all sensitive data.

## Security design and evidence

The policy for publishing this repository is recorded in [ADR-002](docs/adr/002-oss-license-and-publication.md). Architecture decisions are indexed separately so that accepted boundaries are distinguishable from future proposals.

- [Development and security-suite requirements](tasks/README.md) define package boundaries, adversarial test expectations, and the accountless quality gate.
- [Threat model](docs/security/threat-model.md) maps trust boundaries and attacks to named mitigations, permanent tests, and unverified gaps.
- [Benchmark evidence index](docs/benchmarks/README.md) distinguishes measured results from blocked or planned validation.

These documents describe current repository evidence; they are not certifications or guarantees that every deployment is secure. When a report contradicts a documented claim, use the private reporting path above so maintainers can investigate before changing public guidance.
