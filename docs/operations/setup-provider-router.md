# Setup provider router

TenantScript composes resource-specific production setup adapters through an exact operation ID
router. The router keeps one owner for each setup operation and uses the same ownership table for
reconcile and cleanup.

This is composition infrastructure, not a fallback implementation. An unregistered operation stops
the setup run with `setup_provider_route_not_found`; it is never treated as applied. D1 migration,
the remaining Cloudflare resource adapters, live credential input, and clean-account Tier 2 evidence
are still required before `ext setup` can claim a complete deployment.

## Ownership contract

Each route contains a non-empty list of exact operation IDs and one `SetupProviderAdapter`:

```ts
const adapter = createSetupProviderRouter({
  routes: [
    {
      operationIds: ["create:control-plane-d1", "declare:app-database-boundary"],
      adapter: d1Adapter
    }
  ]
});
```

The route table is validated and indexed before any provider call. Empty tables, empty ID lists,
unsafe IDs, unknown configuration fields, invalid adapters, and duplicate operation ownership fail
as `setup_provider_invalid_configuration`.

Routing uses only `request.operation.id`. It does not infer ownership from resource kind, route
order, or `resourceRef`. In particular, cleanup for a journal operation always returns to the same
adapter that reconciles that operation, even if an attacker-controlled resource reference resembles
another provider's prefix. The owner adapter remains responsible for its closed operation and
resource-reference validation.

## Error boundary

The router serializes only these codes:

- `setup_provider_invalid_configuration`
- `setup_provider_route_not_found`

Neither code reflects operation IDs, resource references, delegate payloads, account identifiers, or
credentials. Typed delegate errors are propagated unchanged so operators retain the
resource-specific stable code without exposing provider response bodies.

There is intentionally no wildcard, fallback, or no-op adapter. Add a reviewed exact route only after
the resource adapter has its own TDD, cleanup ownership checks, security-lane coverage, and
operational documentation.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

The composition contract test uses the real D1 adapter with an injected synthetic transport. It
proves exact routing and fail-closed handling without making a live Cloudflare request. Track the
remaining setup implementation and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
