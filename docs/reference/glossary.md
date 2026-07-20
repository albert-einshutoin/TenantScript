# TenantScript glossary

This glossary is the canonical entry point for TenantScript terminology. It describes the current
repository model; linked type definitions, security contracts, and accepted ADRs remain authoritative
for implementation details.

## App

An app is one host SaaS product identified within TenantScript. It is the top-level routing and storage
boundary for authenticated Control Plane requests. An app is not a tenant: one app contains many
tenants, and an authenticated request must resolve its app before tenant-scoped data is accessed. See
[app database routing](../operations/app-database-routing.md).

## Approval

An approval is a time-bounded decision record created by an approval workflow. An authorized actor
approves or rejects it, and a decision may start a new continuation-hook execution. It does not suspend
the original Worker invocation. See [ADR-003](../adr/003-approval-continuation-model.md) and the
[RBAC matrix](../security/rbac-matrix.md).

## Audit record

An audit record is append-only evidence of a security-relevant decision or side effect, such as an
approval decision, capability call, installation mutation, or rollback. It stores scoped metadata, not
raw credentials, provider error bodies, or customer payloads. See
[audit integrity](../security/audit-integrity.md).

## Capability

A capability is a named operation that trusted host code exposes to a plugin through the capability
broker, instead of exposing a raw provider binding or credential. A capability defines what operation
exists; a grant defines whether and within which scope an installation may call it. See the
[SDK reference](sdk.md#tenantscriptcapabilities).

## Control Plane

The Control Plane is TenantScript's product layer for manifests, plugin versions, installations,
approvals, rollback, execution evidence, usage, and administrative authorization. It coordinates
runtime primitives but is not itself the untrusted-code runtime. See the
[product document](../Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md).

## Execution

An execution is one recorded attempt to run a hook for a resolved tenant, installation, and plugin
version. Its evidence includes status, duration, safe logs, and capability-call metadata. An execution
is not an installation and must not become an authority source for later requests. See
[execution retention](../operations/execution-retention.md).

## Grant

A grant is the installation-specific allowlist and scope for a declared capability. The broker checks
it before a provider side effect and records a denial when the call is outside scope. A grant is not an
approval: a grant authorizes a class of calls, while an approval records a human or policy decision for
one workflow subject.

## Hook

A hook is a host-defined, typed extension point that a plugin may implement. Its name, kind, timeout,
and host-schema compatibility range are declared in the manifest. Event, transform, policy, and
continuation behavior follow different failure and sequencing contracts. See the
[Host SDK reference](sdk.md#tenantscripthost-sdk).

## Host SDK

The Host SDK is the package used by the host app to define hooks, validate payloads, resolve execution
plans, and apply failure policy. The Host SDK and Plugin SDK serve opposite sides of the boundary: the
host owns identity and schemas, while plugin code implements declared handlers. See
[`@tenantscript/host-sdk`](sdk.md#tenantscripthost-sdk).

## Installation

An installation binds one tenant to one selected plugin version plus configuration, grants, priority,
and enabled state. It is the mutable operational unit for pinning, disabling, and rollback. A plugin,
a plugin version, and an installation are separate: identity, immutable release content, and
tenant-specific activation must not be conflated.

## Manifest

A manifest is the closed, versioned declaration shipped with a plugin version. It names hooks,
capability requests, configuration schema, egress policy, and execution limits. It describes requested
behavior but does not grant authority; installation grants and authenticated host context still
constrain runtime access. See [`@tenantscript/manifest`](sdk.md#tenantscriptmanifest).

## Plugin

A plugin is the stable logical identity of an extension inside an app, identified by a plugin key. It
groups releases but does not identify executable bytes or a tenant's active configuration. Those roles
belong to plugin version and installation respectively.

## Plugin SDK

The Plugin SDK is the package used by plugin authors to define a manifest-bound handler set and receive
a scoped plugin context. It does not resolve tenant identity or expose raw infrastructure bindings. See
[`@tenantscript/plugin-sdk`](sdk.md#tenantscriptplugin-sdk).

## Plugin version

A plugin version is one registered release of a plugin, pairing a semantic version with a manifest and
content-addressed bundle artifact. Installations pin a specific version so a later release does not
silently change tenant behavior, and rollback selects another previously registered version.

## Runtime primitive

A runtime primitive is a Cloudflare building block such as Workers for Platforms, Dynamic Workers, D1,
R2, Durable Objects, or Workflows. A runtime primitive is not the Control Plane: primitives provide
isolation, storage, or orchestration, while TenantScript provides the product and authorization model.
The final live runtime choice remains subject to [ADR-001](../adr/001-runtime-primitive.md).

## Tenant

A tenant is one customer or isolated customer workspace inside a host app. Tenant scope is derived from
authenticated identity and stored relationships, never accepted as authority merely because a request
body contains a tenant ID. Cross-tenant resources are concealed according to the
[RBAC matrix](../security/rbac-matrix.md).

## Boundary summary

- App selects the host product and database route; tenant selects the isolated customer scope within
  that app.
- Plugin is stable identity; plugin version is release content; installation is a tenant-specific
  activation of one version.
- Capability names an operation; grant authorizes a scoped use of that operation; approval records a
  separate workflow decision.
- Runtime primitives supply infrastructure; the Control Plane supplies product policy, authorization,
  lifecycle, and evidence.
- Host SDK defines trusted host contracts; Plugin SDK defines the constrained authoring surface.
