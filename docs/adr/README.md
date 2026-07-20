# Architecture Decision Records

This directory is the source of truth for TenantScript architecture decisions. Each ADR records a
single decision with its context, outcome, and consequences. For product-level decisions tracked as
D-### in the product document, check this index before adding or changing related ADRs.

## Index

| ID                                            | Title                                      | Date       | Status      | Summary                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------ | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR-000](000-typescript-runtime.md)          | TypeScript Runtime and Repository Language | 2026-06-12 | Accepted    | Use TypeScript, strict ESM, and pnpm workspaces for all first-party packages and applications.                                                                |
| [ADR-001](001-runtime-primitive.md)           | Runtime Primitive Selection                | 2026-06-12 | **Blocked** | Compare Dynamic Workers and Workers for Platforms for tenant plugin execution; **blocked on a paid Cloudflare Workers plan** required to run live benchmarks. |
| [ADR-002](002-oss-license-and-publication.md) | OSS License and Publication Policy         | 2026-06-12 | Accepted    | Publish the repository as public OSS under Apache-2.0 with consistent license metadata across workspace packages.                                             |
| [ADR-003](003-approval-continuation-model.md) | Approval Continuation Model                | 2026-07-05 | Accepted    | Handlers exit after `approvals.request()`; Workflows manage approval lifecycle and start `resumeHook` as a new execution on decision.                         |
| [ADR-004](004-app-database-sharding.md)       | App-level D1 Sharding                      | 2026-07-20 | Accepted    | Provision one D1 database per host app, route only by authenticated app ID, and scale beyond binding limits with deployment-level partitioning.               |

## Adding a new ADR

1. Copy [000-template.md](000-template.md) to the next sequential filename (for example, `003-title-slug.md`).
2. Fill in the metadata block (Date, Deciders, Status) and required sections.
3. Update this index with the new ADR's ID, title, date, status, and one-line summary.
