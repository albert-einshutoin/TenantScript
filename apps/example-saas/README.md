# TenantScript Example SaaS

This app is the fork-safe Phase 0 demo host. It runs entirely in local tests:

- `invoice.created` event -> installed plugin -> `slack.send` mock capability -> execution log
- `webhook.outbound` transform -> installed plugin chain -> transformed payload -> execution log
- zero-integration proxy mode -> docs snippets -> transform -> forwarded webhook request

Run it with:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/example-saas test
```

The demo intentionally uses mock Slack delivery and local execution logs, so contributors can run
the integration without Cloudflare or Slack credentials. Production-oriented Slack OAuth,
rollback, approvals, budget caps, and Admin UI are implemented in their owning Phase 1 packages
and are tested separately.

Start with one of the repository-level guides:

- [SDK integration quickstart](../../docs/quickstarts/sdk-integration.md)
- [Zero-integration proxy mode](../../docs/quickstarts/zero-integration-proxy-mode.md)
- [Rollback troubleshooting](../../docs/operations/rollback-troubleshooting.md)
