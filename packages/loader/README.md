# @tenantscript/loader

The isolated TenantScript plugin loader. It executes bundled plugin handlers with scoped context,
timeouts, subrequest budgets, and no ambient process, binding, or raw-secret access.

Review the [threat model](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/security/threat-model.md)
and security suite before changing isolation, timeout, capability, or continuation behavior.

## Runtime entrypoints

- `@tenantscript/loader` provides `runScopedHandler` for legacy top-level handlers and
  `runScopedPluginDispatch` for the standard scaffold `plugin.dispatch` export in local development,
  replay, and accountless verification. Its terminable Node worker is not the production
  multi-tenant isolation boundary.
- `@tenantscript/loader/cloudflare` provides `createCloudflareDynamicWorkerCaller` for a trusted
  Cloudflare Worker host using a Dynamic Worker Loader binding.

The Cloudflare caller derives an opaque cache ID from the runtime wrapper version, compatibility
date, and complete tenant, installation, plugin, artifact, and grant scope; verifies the artifact
SHA-256 before loading it; adapts the deployed
CommonJS plugin bundle through a fixed Worker fetch wrapper that dispatches the scaffolded
`plugin` export; exposes only trusted scoped
bindings; disables ambient outbound access; and applies CPU/subrequest plus wall-clock limits on
every entrypoint call. Requests, responses, artifacts, configuration, and runtime evidence are
closed and byte-bounded before they cross a trust boundary. Plugin versions longer than the
execution recorder's 128-character limit are rejected before tenant code can run.
Payloads and plugin return values must use the lossless JSON data model; values that JSON would
silently drop or coerce are rejected before invocation or before a success response is emitted.
Hook names preserve the manifest's exact dispatch key, including Unicode, spaces, and slashes, up
to the execution recorder's 256-character persistence limit.

If a plugin calls a capability, the trusted `CAPABILITIES` binding must implement
`call(executionId, name, input)`. The wrapper supplies the server-owned execution ID on every RPC;
the cached binding must use it for journal attribution and must never accept an execution identity
from capability input.

Execution persistence is authoritative. Supply an `ExecutionUsageRecorder` and a trusted evidence
reader; never derive usage or capability calls from tenant-code output. The synchronous caller
records `cpuMs: 0` because wall time is not CPU time. Reconcile exact Cloudflare `CPUTimeMs`
asynchronously from Workers Trace Events Logpush before using CPU usage for cost reporting.
The trusted tail/egress adapter should report `deniedEgressAttempts`; any observed denial prevents
a caught outbound exception from being recorded as success and persists `egress_denied`.
Evidence diagnostics are best-effort and never delay execution persistence. A `reportFailure`
implementation that needs delivery guarantees must schedule its own Cloudflare `waitUntil` work.
Evidence reads use the invocation wall-clock limit as a separate upper bound; a stalled backend is
treated as unavailable so zero evidence can still be persisted.

Cloudflare documents that custom CPU/subrequest limits throw, but does not publish a stable thrown
error shape. Provide `classifyInvocationError` in the host adapter to map verified platform limit
exceptions to `budget_exceeded`; unclassified exceptions remain ordinary runtime errors.

See the [SDK reference](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/reference/sdk.md#tenantscriptloader)
and [usage meter operations](https://github.com/albert-einshutoin/TenantScript/blob/main/docs/operations/usage-meter.md)
for the full contract.

Licensed under Apache-2.0.
