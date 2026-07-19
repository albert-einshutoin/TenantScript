# Security Advisory Response Runbook

Status: active for pre-v1 coordinated disclosure  
Last reviewed: 2026-07-20

This runbook turns the private reporting policy in [`SECURITY.md`](../../SECURITY.md) into an auditable response lifecycle. It does not authorize publishing reporter data or exploit details. Real reports remain in GitHub Security Advisories until coordinated disclosure; only sanitized closeout evidence may enter this public repository.

## Roles and operating rules

- **Incident lead** owns severity, scope, reporter updates, and the disclosure decision.
- **Fix owner** writes the failing regression test and the smallest complete remediation without copying sensitive payloads into fixtures.
- **Reviewer** checks the affected trust boundary, adjacent bypasses, and release/backport scope independently of the fix owner.
- Use synthetic tenant data and redact provider identifiers, account IDs, credentials, customer payloads, and reporter contact details.
- Never move a suspected vulnerability into a public issue, discussion, draft pull request, or normal branch before the advisory decision.
- Set a case-specific remediation target during Triage. The pre-v1 project does not promise a universal fix deadline; the private advisory must record the next update when a target changes.

## Intake

1. Receive the report through [GitHub Security Advisories Private Vulnerability Reporting](https://github.com/albert-einshutoin/TenantScript/security/advisories/new).
2. Acknowledge within the target in `SECURITY.md` and assign an incident lead.
3. Preserve the original report privately. Create a synthetic reproduction rather than copying credentials, tenant data, or a live exploit into the repository.
4. Confirm the affected commit/version, component, deployment prerequisites, and whether exploitation is ongoing.

## Triage

Classify confidentiality, integrity, availability, required authority, tenant/app boundary impact, exploitability, and affected release lines. Use `critical`, `high`, `medium`, or `low`, but record reasoning rather than relying on the label alone.

- Stop and contain first when a credential, cross-tenant path, active exploit, or persistent privilege escalation is plausible.
- For an unsupported configuration or malformed input, confirm whether the result is a bounded validation error, process crash, data corruption, or authority bypass.
- Map the report to [`threat-model.md`](threat-model.md). A missing mitigation or permanent test is part of the finding, not evidence that the report is invalid.
- Decide which maintained versions need a fix. Pre-v1 currently supports only the latest `main` state as documented in `SECURITY.md`.

## Regression test

Write a minimal failing test before the fix. The test must exercise the violated boundary, fail for the reported reason, and use synthetic inputs. Capture the seed/path for property or fuzz failures so the report is reproducible without the original private payload.

Run the narrow test first, then the affected package and adversarial suite. Do not weaken an assertion or silently convert the failure into a fallback just to make the test green.

## Private fix

For a real report, develop inside the GitHub Security Advisory private fork or another maintainer-controlled private workspace. Keep the patch focused, include the regression test, and review adjacent bypasses before publishing.

The fix owner records:

- affected boundary and root cause;
- before/after behavior;
- tests and security suites run;
- compatibility, migration, and backport impact;
- any containment needed before disclosure.

## Advisory decision

Choose one outcome and record the rationale:

- `draft-required`: a supported or distributed version has security impact requiring coordinated disclosure, CVE consideration, release notes, or downstream notification;
- `not-required`: the report is not a vulnerability, affects no supported/distributed version, or is a public synthetic drill with no confidentiality/integrity impact.

`not-required` is not a shortcut around review. The record must still state severity, impact, affected versions, and remaining uncertainty. When an advisory is required, agree on disclosure timing with the reporter, prepare patched releases and regression evidence, and avoid publishing exploit-enabling detail before adopters can update.

## Closeout

1. Run the full repository gate and all affected security suites.
2. Confirm every actionable review thread is resolved, including outdated threads whose concern still applies.
3. Publish the fix/advisory only after the incident lead approves disclosure.
4. Credit the reporter when requested and safe.
5. Add a sanitized drill or incident record only after disclosure. Never commit the private advisory export.
6. Update the threat model, runbook, and permanent test map when the finding changes a boundary.

## Synthetic tabletop drills

Tabletop drills use a public synthetic scenario and do not create or impersonate a real reporter. A committed JSON record must include all six lifecycle stages, chronological timestamps, repository/HTTPS evidence, the advisory decision, and remaining limitations. Credential-shaped fields and repository-external paths are rejected by the checker.

Run the drill evidence gates with:

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:advisory-drills
pnpm test:advisory-drills
pnpm test:security-program
```

The checker validates evidence shape, not whether a real private channel, embargo, reporter communication, or external review occurred. Those limitations must remain explicit in every synthetic record.
