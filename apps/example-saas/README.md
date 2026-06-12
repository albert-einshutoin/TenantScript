# TenantScript Example SaaS

This app is the fork-safe Phase 0 demo host. It runs entirely in local tests:

- `invoice.created` event -> installed plugin -> `slack.send` mock capability -> execution log
- `webhook.outbound` transform -> installed plugin chain -> transformed payload -> execution log
- zero-integration proxy mode -> docs snippets -> transform -> forwarded webhook request

Run it with:

```sh
pnpm --filter @tenantscript/example-saas test
```

The demo intentionally uses mock Slack delivery and local execution logs. Real Slack OAuth,
rollback, approvals, budget caps, and Admin UI belong to Phase 1.

Zero-integration proxy mode is covered by
[`docs/quickstarts/zero-integration-proxy-mode.md`](../../docs/quickstarts/zero-integration-proxy-mode.md).
