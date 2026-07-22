---
"@tenantscript/loader": minor
---

Add `runScopedPluginDispatch` so standard scaffold `plugin.dispatch` bundles can be exercised through
the terminable local sandbox without ambient Node globals or raw egress. The structured SDK dispatch
result is preserved for accountless behavior verification.
