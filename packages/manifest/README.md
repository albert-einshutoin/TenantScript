# @tenantscript/manifest

Closed TenantScript plugin manifest schemas and compatibility validation. Use it to validate hooks,
capability requests, version metadata, and runtime limits before registration.

See the [SDK reference](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/reference/sdk.md)
and [schema diff CI guide](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/reference/schema-diff-ci.md)
for versioning and migration rules.

The package exports the deeply frozen `tenantScriptManifestJsonSchema` draft-07 structural schema.
Use `parseManifest` for authoritative semantic validation. See the
[manifest JSON Schema contract](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/reference/manifest-json-schema.md).

Licensed under Apache-2.0.
