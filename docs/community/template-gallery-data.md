# Template gallery data contract

`templates/catalog.json` is the versioned, deterministic public data source for a future template
gallery and compatibility dashboard. Its closed consumer schema is
`templates/catalog.schema.json`.

The catalog is a projection, not a copy of the submission packet. It includes only display identity,
immutable public source provenance, the tested SDK range/version, hook, capability and configuration
names, deny-only egress, provenance kind, and an approved decision. It deliberately excludes reviewer
identity, evidence paths, security notes, behavior fixtures, and source file maps. Gallery consumers
must not read `templates/submissions/*/submission.json` directly.

## Update and verification

After an approved submission changes, regenerate the artifact:

```sh
# cwd: repository root
# expected-exit: 0
pnpm template-catalog:write
```

Review the catalog diff together with the submission and review-record diff. Then verify that the
committed bytes match the approved packets:

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:template-catalog
```

Tier 1 runs the focused catalog tests and the root lint gate rejects a missing, stale, symlinked, or
non-deterministic artifact. The generator first runs both the full template-submission validator and
plugin-review record validator, including evidence digests and required-unverified gates, and then
requires all five review domains to pass with no blocking finding.

## Authority and non-guarantees

The catalog reports repository evidence for one immutable source revision. It is not a compatibility guarantee
for later source, dependency resolution, SDK releases, registry installation, live deployment, production
suitability, community adoption, or vulnerability absence. `provenance: simulation` remains visibly distinct
from a community submission and must not be presented as external adoption.
