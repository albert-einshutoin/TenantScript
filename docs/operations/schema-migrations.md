# Hook schema migration operations

TenantScript tracks which published hook schema version every installation currently selects. The
tracker is the retirement gate for dual-published schemas: an old version remains published until
its usage reaches zero and no installation has an incompatible range.

## Configure the published catalog

Set `ADMIN_HOOK_SCHEMA_CATALOG_JSON` on the Control Plane Worker to the host application's complete
published schema catalog:

```json
{
  "invoice.created": ["1.0.0", "2.0.0"],
  "invoice.refunded": ["1.0.0"]
}
```

These are host hook schema versions, not plugin package versions. Values must be unique, stable
semantic versions. Malformed, empty, prerelease, or duplicate entries fail closed during request
handling instead of producing incomplete migration evidence. An unset binding means no migrations
are configured and must never be interpreted as proof that a published version is unused.

The same catalog must drive both host payload routing and the Control Plane migration tracker. A
deployment that configures different catalogs can route payloads correctly while reporting stale
retirement evidence.

## What the tracker counts

For each installation hook range, the tracker selects the highest compatible published stable
version. It aggregates all installations in the authenticated application, including disabled
installations because they can be enabled again without changing their manifest.

The Admin UI shows the version usage count, blocking installation identifiers, and incompatible
ranges. Only `owner` and `admin` roles (plus the legacy `manager` claim normalized to `admin`) can
read this app-wide view. `operator` and `viewer` receive an empty migration list. The response never
includes tenant identifiers, plugin configuration, payloads, grants, or manifest contents.

## Retire a schema version

1. Run `ext schema diff` and review every breaking change.
2. Publish the old and new schemas together and keep projection adapters for both versions.
3. Release plugin versions whose manifest ranges accept the new schema, then migrate or upgrade
   every installation.
4. Confirm in the Admin UI that the old version has zero users and there are no incompatible
   installations.
5. In the host publishing workflow, call
   `tracker.assertVersionRemovable({ appId, hookName, version })` immediately before mutating the
   published catalog. Treat any error as a failed release.
6. Remove the old schema and its adapter only after the assertion succeeds, then deploy the same
   reduced catalog to routing and Control Plane configuration.

The assertion is a read-time release gate, not a distributed lock. A host that allows installation
changes concurrently with catalog publication must serialize those operations in its deployment
system or repeat the assertion after pausing writes. Never use the Admin UI count alone as an
authorization decision or remove a version by editing the binding manually.

## Failure handling

- A non-zero usage count returns a stable blocked error with installation IDs that maintainers can
  use to schedule upgrades.
- An incompatible range also blocks retirement; migrate that installation before removing any
  published version for the hook.
- Invalid stored manifests produce a redacted operational error. Repair the stored manifest through
  a reviewed migration; do not bypass validation or delete the installation to make the count pass.
- An invalid catalog must stop the release. A missing catalog produces no migration evidence, so
  configure the reviewed catalog before attempting retirement.

The accountless regression coverage lives in
`packages/control-plane/test/schema-migrations.workers.test.ts`, while cross-role disclosure checks
remain in `packages/control-plane/test/security-suite.test.ts`.
