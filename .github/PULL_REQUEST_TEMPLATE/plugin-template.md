## Template outcome

- Why this template is reusable:
- Previous ecosystem behavior:
- New ecosystem behavior:
- Parent/implementation issue:

## Immutable source and identity

- Public repository:
- Full commit SHA:
- Source directory and SHA-256 map:
- Template slug / plugin name / version:
- Hook name / type / schema range:
- SDK range / exact last-tested version:

## TDD and automated evidence

- RED test and observed failure:
- GREEN/refactor summary:
- `pnpm build` evidence:
- `pnpm test` evidence:
- `ext audit` report and bundle digest:
- Dependency/security scan evidence:

## Security and operation

- [ ] Capability grants are the minimum used by a tested handler path.
- [ ] Egress is denied and the host list is empty; allowlists are not yet accepted by the submission lane.
- [ ] Untrusted input, output bounds, fixed errors, and undeclared-hook rejection are tested.
- [ ] Retry, idempotency, side effects, limits, rollback/disable, and privacy behavior are documented.
- [ ] `SECURITY.md` contains no credential, account identifier, customer/tenant data, or private URL.

## Compatibility, documentation, and License

- [ ] Manifest, package, hook metadata, submission packet, and public SDK contract agree.
- [ ] License metadata and third-party attribution are complete and redistributable.
- [ ] User contract, failure guidance, required configuration, limitations, and migration impact are documented.
- [ ] The machine-checked review record covers security, compatibility, operation, documentation, and license.

## Non-guarantees and external gates

- [ ] Non-guarantees distinguish repository evidence from npm installation, live deployment, independent review, and community adoption.
- Live evidence: verified / not verified / not required (reason and link):
- Independent reviewer: verified / not verified (reason and link):
- Remaining warnings, blockers, or excluded scope:

## Verification

- [ ] `pnpm lint:template-submissions`
- [ ] `pnpm test:template-submissions`
- [ ] `pnpm test:plugin-reviews`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm test:security`
- [ ] `git diff --check`
