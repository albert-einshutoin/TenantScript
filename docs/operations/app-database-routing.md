# App database routing

TenantScript's accepted production direction is one D1 database per host app. The router receives
only an authenticated app ID and returns one explicitly assigned database handle. It never derives
scope from query or request-body claims and never falls back to a shared database.

## Setup-time contract

For every host app, the self-host operator must:

1. create a D1 database with Wrangler or the Cloudflare D1 create API;
2. apply every migration in `packages/control-plane/migrations/`;
3. add a unique uppercase Worker binding such as `APP_ACME_DB`;
4. add exactly one app-to-binding route; and
5. deploy the Worker configuration before sending traffic for the app.

Do not commit account IDs, database UUIDs from private environments, or API tokens. Database
creation needs `D1 Write` only during provisioning; request handling uses Worker bindings and does
not receive that token.

```ts
import { createAppDatabaseRouterFromBindings } from "@tenantscript/control-plane";

const router = createAppDatabaseRouterFromBindings({
  serializedRoutes: JSON.stringify({ app_acme: "APP_ACME_DB", app_example: "APP_EXAMPLE_DB" }),
  bindings: env
});

const database = router.resolve(authenticatedIdentity.appId);
if (database === null) throw new Error("app database is not provisioned");
```

This public composition API is the routing boundary. The repository's default Worker entry still
uses the single `DB` compatibility composition; adopters must not claim physical app sharding until
their authentication directory and HTTP composition select the router result before constructing
app-scoped stores. That remaining composition/setup work stays tracked in
[#22](https://github.com/albert-einshutoin/TenantScript/issues/22).

## Failure contract

- malformed JSON, unsafe app IDs, unsafe binding names, missing bindings, duplicate app IDs, and
  reused databases fail during router construction;
- an unknown app returns `null` and must fail before any store query;
- binding values are never reflected in errors because a mismatched value may be a secret or a
  different privileged Cloudflare resource; and
- tenant predicates remain required in every store even after physical app routing.

## Endpoint isolation registration

Every Admin route is declared in `ADMIN_HTTP_ENDPOINT_CONTRACTS`. Adding an endpoint requires, in
the same pull request:

1. a unique endpoint ID, exact path, allowed methods, and isolation class;
2. an entry in `expectedEndpointIds` in `tenant-isolation-matrix.test.ts`;
3. identity-derived app/tenant scope forwarding coverage for every method;
4. a common `403` or `404` cross-scope result for resource and mutation targets; and
5. inclusion in the permanent security suite.

The HTTP router reads the same registry, so an undeclared endpoint is unreachable instead of
silently missing security coverage.

## Verification

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane test -- test/app-database-router.test.ts test/tenant-isolation-matrix.test.ts
pnpm --filter @tenantscript/control-plane test:security
```
