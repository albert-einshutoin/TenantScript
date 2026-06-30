# ADR-000: TypeScript Runtime and Repository Language

Date: 2026-06-12
Deciders: TenantScript maintainers
Status: Accepted

## Context

TenantScript targets Cloudflare Workers as the primary runtime. Plugin authors, host SDK
integrators, and the control-plane implementation all cross JavaScript or TypeScript boundaries.
The product document records this as D-017.

## Decision

Use TypeScript, strict ESM, and pnpm workspaces for all first-party packages and applications.
Rust and WebAssembly remain candidates for later portability experiments, but they are not the
Phase 0 implementation language.

## Consequences

Cloudflare bindings, SDK types, CLI code, tests, and example plugins can share one language and
one toolchain. Runtime isolation remains a design requirement; TypeScript is the authoring and
control-plane language, not a substitute for sandbox boundaries.
