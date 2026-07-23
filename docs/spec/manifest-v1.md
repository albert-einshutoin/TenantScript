# TenantScript Manifest v1 Portable Specification

This document defines the runtime-independent validation and authority-declaration contract for a
TenantScript plugin manifest. The normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are
used as described by RFC 2119. TypeScript, Zod, Cloudflare Workers, and any particular capability
broker are implementation details rather than requirements of this specification.

The canonical structural schema is the draft-07
[`tenantscript-manifest.schema.json`](../reference/tenantscript-manifest.schema.json). Semantic
conformance is defined by the rules below and the versioned
[`conformance.json`](../../spec/manifest/v1/conformance.json) corpus. An implementation is conformant
only when it satisfies both layers.

## Document model

A manifest MUST be a JSON-compatible object with exactly these top-level members: `name`, `version`,
`hooks`, `capabilities`, `configSchema`, `egress`, and `limits`. Unknown members are rejected at
every closed-object boundary defined by the structural schema.

- `name` identifies a plugin and MUST match `^[a-z][a-z0-9-]*$`.
- `version` identifies one immutable plugin version and MUST be a complete semantic version accepted
  by the published pattern. A range such as `^1.0.0` is not a plugin version.
- `hooks` MUST contain at least one hook. Hook names MUST be unique within the manifest.
- A hook `type` MUST be `event`, `transform`, or `policy`. `timeoutMs` MUST be a positive integer.
  Optional `priority` MUST be an integer; negative priority is valid.
- `schemaVersionRange` MUST be a valid npm-compatible semantic-version range. This is a semantic
  rule and cannot be inferred from the draft-07 structure alone.
- `capabilities` maps capability names to requested grant data. Each name MUST contain at least two
  lowercase dot-separated segments, for example `message.send`.
- `configSchema` declares string, number, or boolean installation values. A default, when present,
  MUST have the declared primitive type. Entries in `required` MUST be non-empty strings.
- `egress.mode` MUST be `deny` or `allowlist`. An allowlist MUST contain at least one non-empty host.
- `limits.cpuMs` and `limits.timeoutMs` MUST be positive integers.

Validation MUST reject malformed input rather than removing unknown fields or coercing values.
Object-key ordering has no meaning. Array ordering is preserved, except that hook-name uniqueness is
evaluated independently of position.

## Authority and runtime boundary

A capability entry is a request for authority. It does not itself grant authority, reveal a
credential, permit network access, or prove that a runtime implements the named capability. A host
MUST separately review and bind requested authority to one installation and tenant before
execution.

A string exactly matching `$config.<identifier>` inside grant data denotes an installation-config
reference in the current TenantScript implementation. A portable host MAY implement this resolution
only after validating installation config against `configSchema`. Missing references MUST fail
closed. Other strings remain literal values.

`egress` declares the plugin's direct-network policy; it does not widen capability-broker authority.
`deny` means direct egress is not requested. An allowlisted host is still subject to host policy,
tenant isolation, DNS/IP safety, and runtime enforcement. A manifest validator MUST NOT claim those
runtime properties merely because the declaration is valid.

`limits` are requested execution ceilings. They do not prove that a runtime enforces CPU or wall
time precisely. Runtime conformance, process isolation, secret handling, storage isolation,
capability implementation, and performance are outside Manifest v1 conformance.

## Stable semantic rule identifiers

| Rule ID                            | Required behavior                                                    |
| ---------------------------------- | -------------------------------------------------------------------- |
| `manifest.valid`                   | Accept the complete valid baseline.                                  |
| `object.closed`                    | Reject unknown members at closed-object boundaries.                  |
| `name.syntax`                      | Enforce the lowercase plugin-name syntax.                            |
| `version.syntax`                   | Enforce a complete plugin semantic version.                          |
| `hooks.non-empty`                  | Require at least one hook.                                           |
| `hooks.unique-name`                | Reject duplicate hook names.                                         |
| `hook.type.enum`                   | Accept only event, transform, or policy.                             |
| `hook.timeout.positive-integer`    | Require a positive integer hook timeout.                             |
| `hook.priority.integer`            | Require an integer when priority is present.                         |
| `hook.schema-version-range.semver` | Require an npm-compatible semantic-version range.                    |
| `capability.key.syntax`            | Enforce lowercase dot-separated capability names.                    |
| `config.default.type-match`        | Require a config default to match its declared primitive type.       |
| `config.required.non-empty`        | Reject an empty required-config key.                                 |
| `egress.allowlist.non-empty`       | Require at least one non-empty host when allowlist mode is selected. |
| `limits.positive-integer`          | Require positive integer CPU and execution limits.                   |

Rule identifiers classify a fixture's primary boundary. They do not promise implementation-specific
diagnostic text or error paths.

## Conformance protocol

The corpus follows
[`conformance.schema.json`](../../spec/manifest/v1/conformance.schema.json). Cases are ordered by
stable `id`; an adapter MUST reject unknown fields, duplicate IDs, unknown rules, invalid
expectations, empty corpora, and ordering drift before invoking its parser.

For every case, the adapter applies its authoritative manifest validator to `input` and emits one
closed result described by
[`result.schema.json`](../../spec/manifest/v1/result.schema.json). A report contains only case ID,
rule ID, expected/actual acceptance, and the total case count. Consumers MUST derive conformance by
comparing each `expected` value with its `actual` value; the protocol intentionally omits redundant
pass/fail fields that could contradict those decisions. It MUST NOT include manifest values, parser
diagnostics, environment data, or absolute paths.

The repository reference adapter can be run without Cloudflare credentials:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/manifest build
node --test scripts/manifest-conformance.test.mjs
node scripts/manifest-conformance.mjs
```

Exit code `0` means every expected acceptance decision matched. Corpus validation failure, adapter
failure, or any mismatch MUST produce a non-zero exit.

## Versioning

Manifest v1 files are append-only compatibility artifacts. Additive fixtures MAY extend the `1.x`
corpus when they clarify existing v1 rules. A change that reverses an existing result, removes or
narrows a field, or changes a rule's meaning MUST use a new specification/corpus major version
instead of overwriting v1.

This specification does not select a WASM runtime, certify a plugin, or establish production
compatibility. Those require separate runtime, security, and operational evidence.
