---
"@tenantscript/control-plane": major
---

Add a browser-safe Slack OAuth callback HTTP route with fixed redirects, binding-cookie deletion across configuration failures, app-scoped encrypted secret references, release-policy protection, real Worker storage composition, and replay-safe state handling. Existing `SecretRef` integrations and encrypted records must follow the [app-scoped secret reference migration guide](../docs/migrations/app-scoped-secret-refs.md).
