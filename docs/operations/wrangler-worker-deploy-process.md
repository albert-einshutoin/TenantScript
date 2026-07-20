# Pinned Wrangler Worker deploy process

TenantScript's CLI exposes `createNodeWranglerWorkerDeployProcess` as the closed process boundary for
the ownership-aware Control Plane Worker adapter. It executes the repository-pinned Wrangler
against one reviewed root-level `.json` or `.jsonc` configuration. It does not acquire credentials,
decide whether a remote Worker is created or adopted, write a setup journal, or prove live Tier 2
deployment.

## Exact command profile

The process accepts only `{ configPath, workerName, ownershipTag }`. The adapter derives the Worker
name and non-secret ownership tag; callers cannot provide an environment, variable, secret file,
compatibility override, route, or arbitrary argument. It invokes
`process.execPath` with the pinned Wrangler script and this fixed argument profile:

```text
wrangler deploy \
  --config <reviewed-root-config> \
  --name <derived-worker-name> \
  --tag <derived-ownership-marker> \
  --strict \
  --experimental-autoconfig=false \
  --install-skills=false
```

Cloudflare documents `--strict` as the defensive deploy mode that stops potential remote-setting
overrides. Wrangler 4.112.0 enables experimental autoconfiguration by default, so TenantScript
disables it explicitly rather than allowing framework detection to widen a reviewed deployment.

- [Wrangler Worker commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Cloudflare Workers Scripts API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/)

## Filesystem and process boundary

The repository root must be absolute, a real directory, and not a symlink. The config and pinned
Wrangler script must be regular non-symlink files whose canonical paths remain inside that root.
Direct symlinks, parent-directory symlink escapes, traversal, absolute config paths, nested config
paths, non-JSON extensions, unsafe characters, and unknown request/configuration fields fail before
spawn.

The child uses an argv array with `shell: false`, ignored stdin/stdout/stderr, repository-root cwd,
`CI=true`, and `WRANGLER_SEND_METRICS=false`. Exit zero is the only success outcome. Timeout, signal,
spawn failure, and non-zero exit become the stable non-reflective
`wrangler_worker_deploy_failed` code. Process output, config content, credentials, and machine-local
paths never enter that error.

## No mutation retry or ownership claim

A timeout or lost response can happen after Cloudflare accepted a deployment. The process therefore
starts Wrangler once and never retries. The Worker adapter reads remote immutable ID and Version tag
state, distinguishes create from explicit adoption, and persists a verified resource reference
before cleanup. `--strict` reduces setting-overwrite risk; it does not prove ownership by itself.

Until complete provider-route coverage and credential-bearing CLI composition exist, operators must
continue to review and run the manual deployment steps in the
[production self-host guide](self-host-production.md). Do not represent this accountless process test
as a successful Cloudflare deployment.

## Accountless verification

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm --filter @tenantscript/cli test:security
```

<!-- tenantscript-command cwd="." expected-exit="0" -->

```sh
pnpm verify
```

Track the ownership-aware Worker adapter, remaining resource composition, and Tier 2 evidence in
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34).
