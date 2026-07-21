# Plugin human review checklist

This checklist is the canonical human-review contract for a TenantScript plugin or template. Use it
after the repository-controlled automated checks pass. A review applies only to the immutable target
and evidence recorded below; it does not transfer to another commit, bundle, dependency graph, or
deployment environment.

## Review target

Record these fields before reading the implementation. If the source and built artifact cannot be
bound to one commit SHA, stop and request changes.

| Field              | Required value                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Repository         | Public repository URL and subdirectory, without credentials or machine-local paths               |
| Revision           | Full commit SHA; a branch or tag alone is not immutable evidence                                 |
| Plugin identity    | Manifest name and plugin/package version                                                         |
| Reviewed inputs    | Manifest path, package metadata path, source path, and bundle digest when a bundle exists        |
| Toolchain          | TenantScript CLI version, plugin SDK version, package manager, and supported runtime             |
| Automated evidence | Exact `ext audit` command, versioned JSON report, test/security run URL, and dependency scan URL |
| Human scope        | Reviewer, review timestamp, compared base revision, and any excluded files or live checks        |

Store evidence in the pull request, a CI artifact, or another access-controlled durable record. Never
paste tokens, credentials, customer payloads, private vulnerability reports, raw production logs, or
absolute workstation paths into the review record.

## Automated audit boundary

Run the repository's documented gates and retain their exact outputs:

```sh
ext audit --manifest ./manifest.json --package ./package.json
pnpm test
pnpm audit --audit-level=high
```

[`ext audit`](../reference/cli.md) V1 checks only closed manifest validity, test-script presence, exact
SDK pin/match, and scaffold limit warnings. It does not inspect source or bundle behavior and does not
prove that grants are used, egress is necessary, tests are meaningful, dependencies are trustworthy,
or a license is compatible. A warning is a request for human review, not evidence of safety. An
accountless check cannot be recorded as live verification.

## Security

Use the [threat model](threat-model.md), [manifest contract](../reference/manifest-json-schema.md), and
[security suite](security-suite-v3.md) as the current repository boundaries.

| Check                      | Verification                                                                                                                       | Blocking condition                                                                                                                                                 | Evidence                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Capability least privilege | Trace every requested capability and scope to a handler call and documented user outcome; remove speculative grants.               | A grant is unused, broader than the demonstrated operation, or cannot be traced to a reviewed code path.                                                           | Manifest line, source line, test name, and audit finding or reviewer note.         |
| Egress and credentials     | Confirm deny-by-default behavior, exact allowlisted hosts, brokered credential injection, redirect policy, and sanitized failures. | Raw `fetch`/socket access bypasses the broker; a host is wildcard/dynamic without a bounded policy; a secret can reach plugin output, logs, errors, or audit data. | Egress declaration, adapter/gateway line, negative test, and redacted test output. |
| Tenant and actor scope     | Follow tenant/app/actor identity from trusted context through reads, writes, cache keys, queues, and idempotency keys.             | Plugin input can select another tenant/app/actor, or storage/effect keys omit the required scope.                                                                  | Scope construction lines and cross-tenant denial test.                             |
| Untrusted input            | Check schema validation, size/count limits, URL parsing, output bounds, and fail-closed behavior before side effects.              | Unbounded input reaches memory/network/storage, validation occurs after a side effect, or an error reflects secret/customer input.                                 | Boundary test names and sanitized error sample.                                    |
| Supply chain               | Review lockfile change, install scripts, dependency ownership, dependency scan, and artifact provenance.                           | High-severity known vulnerability lacks a documented exception; dependency source or built artifact cannot be attributed to the fixed revision.                    | Lockfile diff, scan URL, package provenance, and exception link when applicable.   |

## Compatibility

| Check                      | Verification                                                                                                                                | Blocking condition                                                                                      | Evidence                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| SDK and CLI alignment      | Confirm one exact plugin SDK declaration matches the CLI used for scaffold/audit; compare against the [SDK reference](../reference/sdk.md). | SDK is missing, duplicated, ranged/unpinned, mismatched, or uses an undocumented public API.            | `ext audit` report, package lines, and API reference link.              |
| Manifest and hook contract | Validate the manifest, config defaults, hook type, timeout, and schema version range against the host contract.                             | Manifest is invalid, required config has no migration path, or supported hook/schema range is untested. | Validation output and contract tests for each declared hook/range.      |
| Runtime assumptions        | Identify runtime APIs, module format, CPU/memory/time assumptions, and any platform-specific behavior.                                      | Code depends on unsupported Node/browser/runtime APIs or an unrecorded external service/paid plan.      | Build target, compatibility test, and explicit blocked live-check note. |
| Upgrade behavior           | Review dependency/API changes since the base revision and state backward/forward compatibility.                                             | A breaking config, schema, output, or permission change has no version bump and migration note.         | Diff link, Changeset/release note, and migration test or guide.         |

## Operation

| Check                     | Verification                                                                                                          | Blocking condition                                                                                                                    | Evidence                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Resource limits           | Exercise declared CPU/timeout/output limits with realistic and boundary inputs.                                       | Limits are absent, exceed the accepted review budget without evidence, or permit unbounded work.                                      | Benchmark/test command, result artifact, and approved warning rationale. |
| Retry and idempotency     | Classify failures before/after side effects; verify retry keys and duplicate-delivery behavior.                       | An ambiguous failure is blindly retried, or duplicate delivery can repeat a non-idempotent external effect.                           | Failure-injection test and idempotency contract link.                    |
| Failure and rollback      | Confirm safe partial-failure behavior, operator-visible error codes, disable/rollback steps, and state compatibility. | A failure can leave an untracked side effect or there is no bounded disable/rollback path.                                            | Negative test, runbook link, and rollback rehearsal when applicable.     |
| Observability and privacy | Check useful health/error signals while enforcing the [telemetry privacy contract](../privacy/telemetry.md).          | Logs, traces, metrics, audit fields, or review artifacts contain secrets, customer payloads, or uncontrolled high-cardinality values. | Redaction test and example metadata-only event.                          |

## Documentation

| Check                 | Verification                                                                                                            | Blocking condition                                                                                 | Evidence                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| User contract         | Document purpose, supported hooks, configuration, required grants, egress, outputs, and known limitations.              | An adopter cannot determine what data/effects the plugin can access or which limits apply.         | README/docs links to each contract item.                                  |
| Failure guidance      | Document expected failures, retryability, operator action, and support/reporting route without exposing sensitive data. | Failure behavior is silent, says only "retry", or asks users to publish secrets/customer data.     | Troubleshooting section and sanitized example.                            |
| Reproducible examples | Run examples against the fixed revision and verify commands match public CLI/API contracts.                             | Example requires undisclosed credentials, private paths, or APIs absent from the reviewed version. | CI-backed example/test link and required environment-variable names only. |

## License

| Check                | Verification                                                                                                | Blocking condition                                                                                                                | Evidence                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Plugin license       | Confirm package/repository license metadata and distribution terms are explicit.                            | License is missing, contradictory, non-redistributable for the intended channel, or cannot be attributed to the submitter/source. | `LICENSE`, package metadata, and source provenance link. |
| Third-party material | Review vendored code/assets, generated output, dependency licenses, NOTICE, and attribution obligations.    | Origin or permission is unknown, required attribution is absent, or incompatible terms are bundled.                               | Dependency/license report, NOTICE, and source URLs.      |
| Release artifact     | Compare included files and provenance with the [npm release contract](../reference/npm-package-release.md). | Artifact includes credentials/private files, omits required license files, or cannot be reproduced from the commit SHA.           | Pack-list/tarball test, digest, and provenance URL.      |

## Decision

Choose exactly one outcome:

- `approve`: every applicable row is checked, no blocking finding remains, and every live-only or
  excluded check is explicitly not verified without being required for the claimed distribution.
- `request changes`: a blocking finding is actionable, evidence is missing, or an unverified item is
  required before distribution. List the owner and acceptance evidence for each change.
- `reject`: the plugin requires a prohibited boundary (for example secret exposure or tenant bypass),
  provenance/license cannot be established, or remediation would change the proposed product intent.

One blocking finding is enough to prevent `approve`. `not-applicable` requires a short reason;
`unverified` is never equivalent to passing. Re-run affected automated gates and human rows after any
commit change, including dependency-only or generated-bundle changes.

## Review record template

Repository-owned reviews should also publish a machine-checked record under
[`docs/security/plugin-reviews`](plugin-reviews/README.md). The record checker binds the five-domain
decision to a reachable immutable baseline, pins every evidence file by SHA-256, and invalidates it
when reviewed source or evidence drifts.

Copy this into the pull request and replace every placeholder. Use only `checked`, `failed`, or
`not-applicable` for checklist state; use `not verified` separately for blocked live evidence.

```md
### Plugin review record

- Repository:
- Full commit SHA:
- Plugin name / version:
- Manifest / package / source / bundle digest:
- CLI / SDK / runtime versions:
- Reviewer / reviewed at:
- Compared base / excluded scope:
- `ext audit` report Evidence link:
- Test / security / dependency scan Evidence links:

| Domain        | State (checked / failed / not-applicable) | Evidence link | Blocking finding / rationale |
| ------------- | ----------------------------------------- | ------------- | ---------------------------- |
| Security      |                                           |               |                              |
| Compatibility |                                           |               |                              |
| Operation     |                                           |               |                              |
| Documentation |                                           |               |                              |
| License       |                                           |               |                              |

- Live evidence: verified / not verified / not required (reason and Evidence link):
- Remaining warnings or limitations:
- Decision: approve / request changes / reject
- Decision rationale:
```

## Non-guarantees

This is not a certification. It is a bounded review of one immutable revision and its recorded
artifacts. It does not promise that the plugin is vulnerability-free, compatible with a future
version, suitable for every tenant, compliant with every jurisdiction, or functional in a live
environment that was not explicitly verified. Do not use badges or marketing language that expands
the recorded scope. A later commit, dependency resolution, rebuild, or deployment requires new
evidence and a new decision.
