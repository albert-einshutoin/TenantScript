# TenantScript Example SaaS

This app is the fork-safe Phase 0 demo host. It runs entirely in local tests:

- `invoice.created` event -> installed plugin -> `slack.send` mock capability -> execution log -> usage
- `webhook.outbound` transform -> installed plugin chain -> transformed payload -> execution log -> usage
- zero-integration proxy mode -> docs snippets -> transform -> forwarded webhook request

Run it with:

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/example-saas test
```

The demo intentionally uses mock Slack delivery, local execution logs, and an in-memory usage
summary, so contributors can run the integration without Cloudflare or Slack credentials. Each
dispatch goes through `createExecutionUsageRecorder`: the execution is stored first, then usage
identity, status, and date are derived from that stored authority. `app.usage` exposes query methods
only; the metering mutation is kept inside the composition root.

The accountless host cannot read Cloudflare billing counters, so its example metrics explicitly
record `cpuMs`, `subrequests`, and `workflowRuns` as zero. Passing wall-clock time off as provider
CPU would make the reference integration misleading. A production runtime caller must supply the
real platform measurements. The live Dynamic Workers path and benchmark remain separate paid-plan
evidence gates. Production-oriented Slack OAuth, rollback, approvals, budget caps, and Admin UI are
implemented in their owning Phase 1 packages and are tested separately.

Start with one of the repository-level guides:

- [SDK integration quickstart](../../docs/quickstarts/sdk-integration.md)
- [Zero-integration proxy mode](../../docs/quickstarts/zero-integration-proxy-mode.md)
- [Rollback troubleshooting](../../docs/operations/rollback-troubleshooting.md)
