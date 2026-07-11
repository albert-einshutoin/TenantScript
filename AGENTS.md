# AGENTS.md

Guidance for coding agents working in TenantScript. Keep this file short enough to load by default; use the linked docs for details.

## Start Here

- `README.md`: project direction, GitHub Flow, and current blockers.
- `tasks/README.md`: phase plan, TDD workflow, package boundaries, quality gates, and security-suite expectations.
- `docs/adr/`: architecture decisions. Check the ADR index before changing runtime, licensing, or approval-flow behavior.
- `docs/quickstarts/zero-integration-proxy-mode.md`: proxy-mode contract and CI-backed example snippets.

## Workflow

- Use GitHub Flow: branch from `main`, keep branches short-lived, and open a pull request back to `main`.
- Keep PRs small and focused on one issue or task. Do not bundle broad roadmap edits with implementation work.
- Follow TDD for behavior changes: write the failing test first, make the smallest implementation pass, then refactor while tests stay green.
- Preserve existing package boundaries. The intended dependency direction is documented in `tasks/README.md`; do not introduce reverse dependencies between workspace packages.
- Reference the issue in the PR body with `Fixes #N` or `Refs #N`.

## Safety Guardrails

- Do not commit real credentials, Cloudflare account IDs, API tokens, customer data, database dumps, or machine-local paths.
- Do not assume a Cloudflare paid Workers plan is available. Paid-plan live benchmarks are currently blocked and documented in ADR-001 and `docs/benchmarks/`.
- Do not require maintainers to force-push or rewrite shared history. If a branch needs cleanup, say so in the PR.
- Do not create broad roadmap or governance PRs unless the issue explicitly asks for that scope.
- Treat security tests as first-class behavior tests. Secret exposure, egress bypass, grant escalation, and tenant-boundary changes need explicit coverage.

## Verification

Before opening a PR, run the checks relevant to the change. For normal code changes, use:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

For security-sensitive loader, capability, control-plane, or proxy changes, also run:

```sh
pnpm test:security
```

Docs-only changes should at least pass formatting or targeted doc checks when available.
