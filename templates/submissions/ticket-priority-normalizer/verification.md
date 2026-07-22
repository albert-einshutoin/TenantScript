# Simulated submission verification

This repository-owned simulation exercises the same packet contract intended for a community author.
Tier 1 runs the packet validator, installs freshly packed public TenantScript packages fully offline,
and requires the plugin's own `pnpm build` to emit `manifest.json` and `dist/plugin.cjs`. It then runs
the packet's canonical `ext audit` command against those artifacts and the restored submitted
`package.json`, requiring no findings. Tier 1 also loads that generated CommonJS bundle and dispatches
the packet's bounded success and failure cases against it in individually killable child processes,
requiring exact results and zero capability calls. Each child result is authenticated with a
per-dispatch key, and pending timers, immediates, or post-return capability calls fail verification.
The copied build executes outside the checkout so relative paths cannot reach mutable repository
files beyond the reviewed source snapshot.

The evidence is accountless and first-party. It does not prove public npm installation, a third-party
review, live Cloudflare behavior, community adoption, or suitability for a production support workflow.
