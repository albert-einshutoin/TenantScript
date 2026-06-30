# ADR-002: OSS License and Publication Policy

Date: 2026-06-12
Deciders: TenantScript maintainers
Status: Accepted

## Context

TenantScript is an infrastructure-oriented OSS project. Adopters need patent protection and a
clear self-hosting posture before evaluating or embedding it.

## Decision

Publish the repository as public OSS under Apache-2.0. Every workspace package uses the same
license metadata. The public repository is the canonical source of truth.

## Consequences

Apache-2.0 gives downstream adopters an explicit patent grant while remaining familiar to
infrastructure buyers. Dual licensing is deferred unless a concrete community or adopter need
appears. The npm scope reservation is tracked separately because it depends on registry account
state outside this repository.
