# Cloudflare Worker setup adapter

The accountless Worker adapter owns only `create:control-plane-worker`. It derives one remote name
from the setup run, deploys through the pinned Wrangler process, and records a non-secret ownership
marker in the same upload with `--tag`. Cloudflare exposes that value as the current Worker Version
`workers/tag` annotation, so a journal checkpoint loss can be reconciled without treating the name
or `initial | resume` context as ownership proof.

The same Worker deploy carries the rate-limiter Durable Object binding and SQLite `exports`
declaration. The setup plan therefore has no separate create/cleanup operation for that namespace.
Its lifecycle is coupled to the Worker deployment, while destructive class tombstones remain an
explicit operator-owned migration outside automatic setup rollback.

The adapter uses [Workers Search](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/search/)
with a bounded name query, then reads [Worker settings](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/)
to verify the annotation. Cleanup rechecks the deterministic name, the digest of Cloudflare's
immutable Worker ID, and the ownership marker before calling the
[DELETE endpoint](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/).

## Safety contract

- An existing target on an initial attempt is a conflict, even if its marker happens to match.
- Resume may reconstruct `created` only when the provider marker matches the canonical reconcile
  key for the same setup run.
- A missing target may be deployed once. An ambiguous Wrangler failure is followed by reads only;
  the deploy mutation is never replayed.
- Adopt mode requires an explicit Worker name and is never cleanup eligible.
- Partial, duplicate, oversized, malformed, or widened provider responses fail closed.
- Resource references contain the deterministic name and an immutable-ID digest, not the raw setup
  run, idempotency key, provider response, configuration, or credential.
- A missing Worker or DELETE 404 is idempotent cleanup success. Every other ownership or provider
  drift requires operator review and blocks deletion.

This is Tier 1 accountless contract evidence. It does not prove Cloudflare credentials, propagation,
Durable Object lifecycle reconciliation, request routing, or clean-account setup. Those require the
separate Tier 2 live workflow.
