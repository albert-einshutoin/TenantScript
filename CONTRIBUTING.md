# Contributing to TenantScript

Thank you for improving TenantScript. The project welcomes focused bug fixes, tests, documentation, security hardening, and features that advance the published phase plan without weakening tenant isolation or capability boundaries.

## Start here

Before changing code, read:

- [Development plan](tasks/README.md): canonical package boundaries, TDD workflow, phase gates, and quality requirements.
- [Architecture Decision Records](docs/adr/README.md): canonical decisions that constrain runtime, licensing, approval flow, and future architecture.
- [Benchmark evidence](docs/benchmarks/README.md): measured, blocked, and planned validation with reproducibility requirements.
- [Security policy](SECURITY.md): private vulnerability reporting and sensitive-data rules.
- [Code of Conduct](CODE_OF_CONDUCT.md): community behavior, confidential reporting, and enforcement.
- [Good-first-issue pipeline](docs/community/good-first-issues.md): bounded newcomer tasks with explicit verification.
- [AGENTS.md](AGENTS.md): concise repository workflow and safety guardrails for humans and coding agents.

If these documents conflict, an accepted ADR governs the architecture, while the current issue or task defines the approved change scope. Ask in the issue before expanding that scope.

## Development setup

TenantScript uses Node.js 24, Corepack, pnpm 10.12.1, strict TypeScript, and ESM. Tier 1 tests are accountless and must not require Cloudflare or third-party credentials.

```sh
# cwd: repository root
# expected-exit: 0
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Do not commit `.env` files, tokens, Cloudflare account IDs, customer data, database dumps, generated coverage, build output, or machine-local paths. Update `.gitignore` when a new tool produces local artifacts.

## Choose or propose work

Search open issues and pull requests before starting. Prefer an issue with explicit context and acceptance criteria. A useful issue explains:

- why the change matters to adopters or contributors;
- the intended behavior and package boundary;
- security and compatibility risks;
- a RED test or, for configuration and documentation, a concrete verification checklist;
- the goal and Definition of Done.

Keep one pull request focused on one issue. Discuss broad roadmap changes before implementation; do not combine governance, architecture, and unrelated feature work.

## GitHub Flow

TenantScript uses GitHub Flow with `main` as the only long-lived branch.

1. Synchronize `main` and create a short-lived branch.
2. Make small commits in the form `<type>: <description>`.
3. Push the branch and open a pull request to `main`.
4. Resolve review threads and wait for required checks.
5. Squash merge after approval, then delete the merged local and remote branch.

Never force-push shared history to make a contribution acceptable. If a branch cannot be safely updated, explain the conflict in the pull request.

## TDD: RED, GREEN, REFACTOR

Behavior changes follow this order:

1. **RED**: add the smallest test that fails for the missing behavior. Run it and confirm the expected failure.
2. **GREEN**: implement the smallest complete behavior that satisfies the user-facing contract.
3. **REFACTOR**: improve names, boundaries, and duplication while tests remain green.
4. Confirm the issue's Definition of Done and package coverage of at least 80%.

Tests should state behavior, use deterministic clocks and I/O, and avoid timeout-based sleeps. Prefer unit tests, then workerd-backed integration tests for D1/R2/Durable Objects, and focused E2E coverage for product journeys.

Documentation and configuration changes use a failing contract check or explicit verification checklist instead of artificial unit tests. Every contributor-facing shell block must declare its working directory and expected exit code so commands remain reproducible.

## Architecture and implementation rules

Preserve the dependency direction in [tasks/README.md](tasks/README.md). In particular, lower-level SDK and manifest packages must not import control-plane or application packages.

- Use TypeScript strict mode and public package exports; do not import another workspace's private `src/*` paths.
- Validate untrusted input at the boundary and return stable errors without reflecting provider or storage details.
- Derive app, tenant, actor, and role from authenticated identity, not request-body claims.
- Give plugins scoped capabilities, never raw provider bindings or credentials.
- Comment why a non-obvious business rule, memory strategy, or optimization is necessary—not what the syntax already says.

Architecture changes require an ADR proposal or an update to an existing ADR. Do not silently overturn an accepted decision in an implementation pull request.

### Add or change a capability

Every capability must join the shared contract in `packages/capabilities/test/capability-contracts.test.ts`. Add a fixture that proves a granted call succeeds, capability-specific scope is enforced, journal replay is idempotent, rate limiting occurs before provider execution, audit records contain metadata only, and provider failures use a stable error shape.

Keep provider credentials inside the provider closure; never add them to plugin input, context, results, errors, or audit records. Validate destination, tenant, role, field, and other scopes before the provider performs an external side effect. Add focused adversarial coverage to `packages/capabilities/test/security-suite.test.ts` whenever a capability can expose secrets, cross tenant boundaries, or reach an external service.

Run the capability checks during RED/GREEN iteration, then run the repository gate:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/capabilities test
pnpm --filter @tenantscript/capabilities test:security
pnpm verify
```

## Security verification

Secret exposure, egress bypass, grant escalation, tenant-boundary access, approval authorization, and audit mutation are behavior regressions and require adversarial tests. Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in a public issue or draft pull request.

`pnpm verify` is the canonical local Tier 1/accountless gate. It runs type checking, lint, behavior tests, package coverage, adversarial security tests, dependency audit, and formatting in a deterministic order. Run it before opening a code pull request:

```sh
# cwd: repository root
# expected-exit: 0
pnpm verify
git diff --check
```

Docs-only changes must at least run `pnpm docs:check`, formatting, the issue verification commands, and any command shown in the changed guide. Security-sensitive documentation should also run the security suite when it claims or changes a security contract.

## Pull request expectations

A reviewable pull request states:

- why the change is needed and which issue it fixes or references;
- the previous behavior and the new behavior;
- implementation and architecture decisions, including rejected alternatives when useful;
- RED/GREEN evidence and exact verification commands;
- security, compatibility, migration, and operational impact;
- known limitations or manual/external validation still required.

Use `Fixes #N` only when every acceptance criterion is satisfied. Green CI does not replace review: resolve every actionable thread, including threads marked outdated when the underlying concern still applies.

Contributions are accepted when they fit the documented scope, preserve security boundaries and package direction, include proportionate tests and documentation, and pass required checks. Maintainers may ask to split a pull request that is too broad to review safely.

## Adoption reports and product feedback

Adopter listing is voluntary and separate from telemetry. To add a public entry, update
[`ADOPTERS.md`](ADOPTERS.md) using the
[adopter report template](.github/PULL_REQUEST_TEMPLATE/adopter-report.md). The submitter must be
authorized to publish every name and must remove customer/tenant data, account identifiers,
credentials, private URLs, and confidential metrics. Maintainers verify public consent and safe
content before merge.

Adopters who cannot publish a name can use the
[anonymous feedback form](https://github.com/albert-einshutoin/TenantScript/issues/new?template=feedback.yml).
The issue is still public, so use broad synthetic context and omit organization, customer,
deployment, and tenant details. Reproducible defects use the bug template. Public security
hardening proposals use the security-adjacent template; suspected vulnerabilities always follow
the private process in [`SECURITY.md`](SECURITY.md).

## Review and conduct

Review the change, not the person. Explain security or architecture concerns with concrete evidence and offer a path forward. Harassment, disclosure of private information, and unsafe publication of vulnerabilities are not acceptable.

All participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Project decision-making and the
path to co-maintainership are described in [GOVERNANCE.md](GOVERNANCE.md).
