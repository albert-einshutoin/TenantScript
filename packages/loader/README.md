# @tenantscript/loader

The isolated TenantScript plugin loader. It executes bundled plugin handlers with scoped context,
timeouts, subrequest budgets, and no ambient process, binding, or raw-secret access.

Review the [threat model](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/security/threat-model.md)
and security suite before changing isolation, timeout, capability, or continuation behavior.

Licensed under Apache-2.0.
