---
"@tenantscript/loader": minor
---

Add a Cloudflare Worker-compatible Dynamic Worker production caller with scoped isolate reuse,
artifact integrity verification, a CommonJS handler adapter, bounded wire contracts, CPU,
subrequest and wall-clock limits, and authoritative execution usage recording.
Verified platform limit exceptions can be classified as `budget_exceeded` without relying on
unstable provider error text.
Lossy JSON payloads and plugin return values are rejected instead of being silently coerced.
Stalled evidence reads are bounded so authoritative execution persistence can still complete.
Legacy handler fallbacks receive the trusted hook type and enforce blocking hook return contracts.
The v2 wrapper captures trusted intrinsics before lazily evaluating tenant code and re-validates
dispatch results against the host-owned hook type.
Response JSON is constructed with captured primitives so tenant-mutated JSON hooks cannot alter the
validated envelope.
Generated CommonJS namespace shapes are unwrapped before dispatch, and policy decisions require
own data properties.
Legacy handler lookup accepts only own function-valued data properties.
Unawaited capability RPCs are drained before the wrapper can emit a successful response.
Capability failures handled by tenant await/catch or rejection callbacks remain catchable;
calls with no rejection path still fail the invocation after draining.
Trusted denied-egress evidence prevents caught outbound failures from being recorded as success.
Denied egress remains a first-class execution status, and control characters in hook names are
rejected before tenant invocation.
