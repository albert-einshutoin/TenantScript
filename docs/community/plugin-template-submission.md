# Community plugin template submission

This guide is the canonical path for proposing a reusable TenantScript plugin template. It turns a
source snapshot, least-privilege metadata, automated evidence, and human review into one
machine-checked packet. A passing packet is eligible for maintainer review; it is not a certification,
gallery publication decision, community endorsement, or proof of live deployment.

## Verification status

- **Repository verified** — Tier 1 validates every packet, binds repository-owned source to a full
  commit SHA and SHA-256 map, installs freshly packed TenantScript packages, then builds, tests,
  bundles, and audits every submitted plugin snapshot.
- **Repository verified / first-party** — the `simulation` packet proves that the public workflow can
  be completed without credentials. It does not claim an external contributor or independent review.
- **Blocked** — public npm installation, live Cloudflare behavior, actual community adoption, and an
  independent reviewer require external evidence and remain separate from this accountless gate.

## Packet layout

Each candidate lives at `templates/submissions/<slug>/submission.json` and follows
[`templates/submission.schema.json`](../../templates/submission.schema.json). The directory also
contains a plugin source snapshot, `SECURITY.md`, and sanitized verification evidence.

```text
templates/submissions/<slug>/
├── submission.json
├── SECURITY.md
├── verification.md
└── plugin/
    ├── package.json
    ├── tsconfig.json
    ├── src/index.ts
    ├── src/manifest.ts
    └── test/plugin.test.ts
```

Use `kind: "community"` only for a real external proposal whose public authorship and provenance are
accurate. Repository-owned rehearsal data uses `kind: "simulation"`; never present it as community
adoption or independent validation.

## 1. Implement the source with TDD

Start from a built-in `ext init --template` template or a minimal plugin. Add the failing behavior and
security-boundary tests first. The final source must include a manifest, handler, test, exact
TenantScript package versions, explicit license, strict TypeScript configuration, and bounded
`SECURITY.md` guidance.

The manifest and packet must agree exactly on hook name/type, capability names, configuration keys,
and egress mode/hosts; Tier 1 compares them before build and audit. Keep capabilities empty and egress
denied unless the reviewed behavior needs narrower declared access. Never include tokens, credentials,
raw account identifiers, customer/tenant data, private URLs, production logs, or machine-local paths
(including `file:///home/...`, `file:///tmp/...`, and Markdown-wrapped `` `/workspace/...` `` paths).
Repository paths may use legitimate security vocabulary such as `token-refresh.ts`; the checker scans
the digest-bound file contents instead of treating path segments as secret fields.
The exact `@tenantscript/manifest` and `@tenantscript/plugin-sdk` dependency versions must equal
`sdk.lastTestedVersion`; the declared caret range must include that version.

```sh
# cwd: template plugin directory
# expected-exit: 0
pnpm build
pnpm test
```

## 2. Freeze source provenance

Commit the complete plugin source before writing its packet. Record the full commit SHA—not a branch,
tag, abbreviated SHA, or mutable URL—and SHA-256 every regular file under the packet's `plugin/`
directory. The digest map must cover that directory exactly; unlisted helpers, build inputs, and
symlinks are rejected. Package-manager control files such as `.pnpmfile.cjs`, `.npmrc`, and
`pnpm-workspace.yaml` are also rejected because they can execute hooks or alter installation before
the audited bundle is produced. The package must not define `preinstall`, `install`, `postinstall`, or
`prepare` scripts or a root `pnpm` settings block. Do not amend or force-push the source commit after
review starts; a legitimate change creates a new commit and new digests.
Use the HTTPS repository-root URL for `source.repository`; GitHub `/tree/...` and `/blob/...` browser
URLs are rejected because they are not repository identities.

```sh
# cwd: repository root
# expected-exit: 0
git rev-parse HEAD
shasum -a 256 templates/submissions/<slug>/plugin/package.json
```

For repository-owned source, the validator always checks the current regular file against the digest
map and also checks the recorded revision when that Git object is available. The digest map remains
the enforceable source identity after a squash merge removes PR-local commits from public ancestry.
External repositories are not fetched during accountless CI: their full SHA and vendored digest map
are syntactically checked, while provenance remains a blocking human-review item until durable
external evidence is inspected. Submission installation also runs fully offline; missing package
metadata fails the gate instead of reaching a registry.

`pnpm build` must create `manifest.json` and `dist/plugin.cjs` in the plugin root. Tier 1 then runs the
packet's canonical `ext audit` command against those exact artifacts and the restored submitted
`package.json`; install-only local tarball overrides are never audited as a substitute.

## 3. Complete submission metadata

The closed packet schema requires:

- stable slug, display name, bounded summary, and SPDX-style license metadata;
- public HTTPS source repository, full commit SHA, source directory, and sorted SHA-256 file map;
- pinned SDK caret range and exact last-tested version;
- one hook name/type, sorted capabilities and config keys, plus explicit deny or host allowlist egress;
- canonical build, test, and audit commands with repository-local evidence;
- an approved review record, security note, and explicit non-guarantees.

The canonical audit command recorded in the packet is:

```sh
# cwd: template plugin directory
# expected-exit: 0
ext audit --manifest ./manifest.json --package ./package.json --bundle ./dist/plugin.cjs
```

The validator never executes submitted commands or downloads submitted repositories. It scans packet
metadata, every digest-bound source file, verification evidence, and the security note for
credential-like or private content without reflecting submitted values in findings. Execution occurs
only in the repository-controlled E2E after metadata, paths, complete source digests, and a review
record bound to the same source scope and digest map pass. The E2E discovers every submission
directory so a new packet cannot silently receive static validation alone.

## 4. Run the submission gates

Run the focused checks before the full repository gate. Findings are sorted and identify only the
packet file, field, and stable reason; submitted values are not reflected. Fix the contract violation
instead of suppressing a finding or weakening a digest.

```sh
# cwd: repository root
# expected-exit: 0
pnpm lint:template-submissions
pnpm test:template-submissions
pnpm test:plugin-reviews
git diff --check
```

Then run the normal accountless gate:

```sh
# cwd: repository root
# expected-exit: 0
pnpm verify
```

## 5. Complete human review and the pull request

Apply the [Plugin human review checklist](../security/plugin-review-checklist.md) to the immutable
source and evidence. Security, compatibility, operation, documentation, and license must each pass;
one blocking finding prevents approval. Store the machine-checked record under
`docs/security/plugin-reviews/` and reference it from the packet.

Open the pull request with
[`plugin-template.md`](../../.github/PULL_REQUEST_TEMPLATE/plugin-template.md). The pull request must
explain why the template is reusable, the previous and new ecosystem behavior, RED/GREEN evidence,
capability and egress decisions, provenance, license, limitations, and every unverified external gate.
Maintainers resolve all actionable review threads and wait for Tier 1 and security checks before merge.

## Failure guidance

- **source digest or revision mismatch** — create a new immutable source commit, recompute every source
  digest, repeat build/test/audit, and refresh the review record.
- **missing or unsafe evidence** — add a sanitized repository-local artifact; never paste a credential,
  customer payload, private URL, or machine path into the packet.
- **capability or egress mismatch** — remove speculative access or add the narrow grant, handler call,
  negative test, audit evidence, and reviewer rationale together.
- **review record rejected** — complete all five domains and remove blockers; `unverified` is not a pass.
- **live or registry check unavailable** — mark it not verified with a reason. Do not convert an
  accountless result into a live claim.

## Non-guarantees

Schema validation, a finding-free `ext audit`, green tests, and first-party approval are bounded
evidence—not proof that a template is vulnerability-free, suitable for every tenant, compatible with
future releases, legally appropriate, adopted by the community, or safe in an untested live runtime.
Gallery publication and independent review remain explicit later decisions.
