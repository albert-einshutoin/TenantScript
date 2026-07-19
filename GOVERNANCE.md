# TenantScript Governance

TenantScript uses lightweight maintainer governance appropriate for a pre-v1, security-sensitive OSS project. This document defines responsibility and decision-making without committing the project to unapproved roadmap dates or naming external maintainers.

## Principles

- Protect tenant isolation, least-privilege capabilities, secret confidentiality, and auditable operations before optimizing convenience.
- Keep technical decisions, phase plans, issues, and pull requests public whenever disclosure is safe.
- Prefer reversible, evidence-backed changes and small GitHub Flow pull requests.
- Separate implemented behavior, runtime evidence, and release readiness.
- Do not present blocked external validation as completed.

The canonical execution plan and quality gates are in [tasks/README.md](tasks/README.md). Accepted technical decisions are indexed in [docs/adr/README.md](docs/adr/README.md).

## Roles

### Contributor

Anyone who reports a reproducible problem, improves documentation, reviews a change, or submits code. Contributors do not need commit access. The contribution workflow is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

### Reviewer

A trusted contributor who regularly provides accurate review in one or more project areas. Reviewers can recommend changes or approval, but repository write access is not implied.

### Maintainer

A person entrusted with repository administration and the final responsibility for safe integration. Maintainers:

- triage issues and keep acceptance criteria actionable;
- review architecture, security, compatibility, and test evidence;
- ensure required CI and unresolved review threads are checked before merge;
- manage releases, advisories, branch protection, and repository settings;
- keep roadmaps and status claims aligned with live evidence;
- remove merged branches and protect shared history;
- apply the [Security Policy](SECURITY.md) for private reports.

Repository access is least-privilege and may be reduced when it is no longer required or cannot be exercised safely.

## Decision process

Routine, reversible implementation decisions are made through issue discussion and pull-request review. The responsible maintainer merges when acceptance criteria, evidence, and required checks are satisfied and no actionable review thread remains.

An Architecture Decision Record (ADR) is required for decisions that are difficult to reverse or that change runtime selection, package boundaries, public API compatibility, licensing, tenant or capability security, persistence semantics, or approval execution. ADRs follow the template and index in [docs/adr/README.md](docs/adr/README.md).

Decision sequence:

1. State the context, constraints, security impact, and alternatives.
2. Gather evidence through tests, prototypes, benchmarks, or operational data.
3. Seek consensus from affected maintainers and active domain contributors.
4. Record the decision and consequences in an ADR before or with implementation.
5. If consensus is not reached, keep the current accepted behavior. A maintainer may make a time-sensitive security containment decision, document why, and follow with retrospective review.

An accepted ADR is changed by a new ADR that explicitly supersedes it; history is not rewritten to hide the earlier decision.

## Pull request authority

Authors do not merge their own security-sensitive or architecture-changing pull requests without independent review when another maintainer is available. A maintainer must not merge while required CI is failing, mergeability is unknown, or an actionable review thread remains unresolved.

Emergency security containment may temporarily precede the normal process when public delay increases adopter risk. The maintainer records the scope privately in the advisory, limits the change to containment, and adds tests, disclosure, and public rationale when coordinated disclosure permits.

## Becoming a co-maintainer

Co-maintainership is earned through sustained, trustworthy project work rather than a fixed number of commits. A candidate should demonstrate:

- repeated contributions or reviews that preserve architecture and security boundaries;
- sound judgment about scope, tests, compatibility, and operational risk;
- respectful, clear communication and reliable follow-through;
- familiarity with the TDD, ADR, release, and private security-reporting processes;
- willingness to maintain existing work, not only add new features.

Existing maintainers discuss the candidate using public contribution evidence and private security or conduct information only when necessary. Maintainers seek consensus, document the granted role and scope, and begin with the minimum repository permission required. No external person or organization receives maintainer status solely through sponsorship, employment, or affiliation.

Co-maintainers are expected to disclose conflicts of interest, recuse themselves when independent judgment is compromised, protect embargoed vulnerability information, and hand off responsibilities when inactive for an extended period.

## Changes to governance

Governance changes require a focused public issue and pull request. The proposal must explain the problem, affected roles, transition, and risks. It must not silently create named leadership positions, roadmap commitments, or commercial obligations.

Security-sensitive access details and personal information are never recorded in this public document.
