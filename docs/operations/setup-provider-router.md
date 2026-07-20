# Setup provider router

TenantScript composes resource-specific production setup adapters through an exact operation ID
router. The router keeps one owner for each setup operation and uses the same ownership table for
reconcile and cleanup.

This is composition infrastructure, not a fallback implementation. Required operation coverage is
validated before the first provider call, and an unregistered runtime request stops with
`setup_provider_route_not_found`; neither case is treated as applied. The D1 resource
and migration operations now have accountless adapters and a production migration runner, but the
remaining Cloudflare resource adapters, live credential input/composition, and clean-account Tier 2
evidence are still required before `ext setup` can claim a complete deployment.

## Ownership contract

Each route contains a non-empty list of exact operation IDs and one `SetupProviderAdapter`:

```ts
const adapter = createSetupProviderRouter({
  requiredOperationIds: ["create:control-plane-d1", "declare:app-database-boundary"],
  routes: [
    {
      operationIds: ["create:control-plane-d1", "declare:app-database-boundary"],
      adapter: d1Adapter
    }
  ]
});
```

The route table is validated and indexed before any provider call. `requiredOperationIds` is a
non-empty, bounded, duplicate-free set. Its members must exactly equal the union owned by all
routes; declaration order has no meaning. Missing routes and accidental extra routes therefore fail
at construction as `setup_provider_invalid_configuration`, before D1/R2 creation or migration can
change remote state. Empty tables, empty or unsafe IDs, unknown configuration fields, invalid
adapters, and duplicate operation ownership fail with the same non-reflective code.

Production callers must derive the complete requirement from the selected plan, not filter only the
currently implemented operations:

```ts
const plan = createProductionSetupPlan("cloudflare-workers");
const requiredOperationIds = plan.operations.map((operation) => operation.id);
```

The current plan still contains `integration-required` operations without production adapters, so a
complete live router cannot yet be constructed. This is deliberate: starting a partial live setup
could apply migrations to an adopted database before discovering a missing downstream provider,
and that irreversible state change cannot be repaired by deleting only setup-owned resources.

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

The composition contract tests use the real D1, migration, and R2 adapters with injected synthetic
boundaries. They prove exact ownership, complete declared coverage, and fail-closed handling without
making a live Cloudflare request. Track the
remaining setup implementation and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
