# Simulated submission verification

This repository-owned simulation exercises the same packet contract intended for a community author.
Tier 1 runs the packet validator, installs freshly packed public TenantScript packages fully offline,
and requires the plugin's own `pnpm build` to emit `manifest.json` and `dist/plugin.cjs`. It then runs
the packet's canonical `ext audit` command against those artifacts and the restored submitted
`package.json`, requiring no findings.

The evidence is accountless and first-party. It does not prove public npm installation, a third-party
review, live Cloudflare behavior, community adoption, or suitability for a production support workflow.
