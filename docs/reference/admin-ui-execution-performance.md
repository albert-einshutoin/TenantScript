# Admin UI 100k execution browser budget

Status: **Repository verified**

The executions screen combines Control Plane keyset pagination with a bounded browser DOM window.
Operators can keep loading signed-cursor pages without making React reconcile every accumulated row.
The loaded summaries remain in JavaScript memory so search results, page append order, and execution
detail lookup stay stable; this gate bounds rendered DOM work rather than claiming constant total
memory.

## Fixed budget

The accountless Chromium fixture generates 100,000 synthetic `ExecutionView` records and enforces:

| Measurement                                                  |           Budget | Current local observation |
| ------------------------------------------------------------ | ---------------: | ------------------------: |
| Data rows present in the DOM                                 |       at most 32 |      15 at initial render |
| Fixture construction through first committed animation frame | at most 1,000 ms |                   28.2 ms |

Rows use a fixed 52 px height inside a 520 px viewport with five overscan rows on each side. These
constants make the scroll-to-row mapping deterministic. The table publishes the logical total through
`aria-rowcount`, each rendered row publishes `aria-rowindex`, and the keyboard-focusable viewport is
an `Execution results` region. Column headers and `View <execution-id>` actions remain native table
and button semantics.

The local observation was recorded with repository Chromium on 2026-07-21. It is a baseline, not a
portable latency promise. The 1,000 ms CI limit is the enforced cross-run contract.

## Reproduce

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:admin-ui-performance
```

The Playwright test also scrolls the 100,000-row logical table to `exec_perf_099999`, checks that the
DOM remains bounded, and activates that row's detail button. Tier 1 runs the same command on every
pull request. The fixture under `apps/admin-ui/test/e2e/fixtures/` contains generated identifiers and
fixed timestamps only; Vite's production entry remains `index.html`, so the fixture and 100,000-row
dataset are not part of the production bundle.

## Updating the budget

A pull request that changes row height, viewport height, overscan, or the time/DOM limits must include:

1. the reason the operator experience needs the change;
2. before/after measurements from `pnpm test:admin-ui-performance`;
3. confirmation that initial and final logical rows remain reachable;
4. confirmation that `aria-rowcount`, `aria-rowindex`, column headers, and detail button names remain;
5. a bundle-budget result, because adding a virtualization dependency affects a separate gate.

Do not raise a limit merely to make a slow CI run pass. Investigate data construction, rendered row
count, dependency weight, and accidental fixture inclusion first.

## Evidence boundary

This proves deterministic behavior in repository-managed headless Chromium. It does **not** prove
Control Plane query throughput, D1/R2 latency, network transfer time, browser memory under every
operator workload, paid Cloudflare performance, or field-device responsiveness. Signed cursor
validation and tenant isolation remain Control Plane security contracts; the UI never manufactures or
rewrites cursors. Live service performance belongs in the credentialed Tier 2 benchmark lane.
