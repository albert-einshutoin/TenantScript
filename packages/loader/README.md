# @tenantscript/loader

The isolated TenantScript plugin loader. It executes bundled plugin handlers with scoped context,
timeouts, subrequest budgets, and no ambient process, binding, or raw-secret access.

Review the [threat model](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/security/threat-model.md)
and security suite before changing isolation, timeout, capability, or continuation behavior.

## Runtime entrypoints

- `@tenantscript/loader` provides `runScopedHandler` for local development and replay. Its
  terminable Node worker is not the production multi-tenant isolation boundary.
- `@tenantscript/loader/cloudflare` provides `createCloudflareDynamicWorkerCaller` for a trusted
  Cloudflare Worker host using a Dynamic Worker Loader binding.

The Cloudflare caller derives an opaque cache ID from the complete tenant, installation, plugin,
artifact, and grant scope; verifies the artifact SHA-256 before loading it; exposes only trusted
scoped bindings; disables ambient outbound access; and applies CPU/subrequest limits on every
entrypoint call. Requests, responses, artifacts, configuration, and runtime evidence are closed and
byte-bounded before they cross a trust boundary.

Execution persistence is authoritative. Supply an `ExecutionUsageRecorder` and a trusted evidence
reader; never derive usage or capability calls from tenant-code output. The synchronous caller
records `cpuMs: 0` because wall time is not CPU time. Reconcile exact Cloudflare `CPUTimeMs`
asynchronously from Workers Trace Events Logpush before using CPU usage for cost reporting.

See the [SDK reference](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/reference/sdk.md#tenantscriptloader)
and [usage meter operations](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/operations/usage-meter.md)
for the full contract.

Licensed under Apache-2.0.
