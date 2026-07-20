# Admin UI accessibility gate

TenantScript treats keyboard and automated accessibility behavior as a repository-verified Admin UI
contract. The gate runs locally and in Tier 1 with no account or deployed environment:

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:admin-ui-accessibility
```

## Guaranteed behavior

The Playwright journey signs in with the synthetic manager fixture and checks login plus Overview,
Installations, Versions, Approval queue, Executions, Connections, and Audit log. Every state must
report **zero violations** from axe. The scan uses the full default axe rule set: contributors must
not disable rules or broadly exclude application regions to make the gate pass.

A separate keyboard only journey uses Tab, Shift+Tab, Space, Enter, and typed input to complete:

1. plugin configuration and capability confirmation;
2. installation review and confirmation;
3. rollback review, cancel, focus restoration, and confirmation;
4. approval reason entry and approval confirmation.

Scrollable table regions have an accessible name and keyboard focus. Confirmation dialogs move
focus to the first safe control, keep Tab focus inside the modal, support Escape when cancellation is
safe, and restore focus to the invoking control when it still exists.

## Change policy

Fix semantic markup, accessible names, contrast, or focus management at the source. An axe
`disableRules` call, broad `exclude`, or CSS that hides focus indication is not an acceptable update.
When a primary route or privileged flow is added, extend the journey in the same pull request.

The fixture contains synthetic metadata only. Do not put bearer tokens, customer data, provider
credentials, or secret references into failure messages, screenshots, or traces.

## Evidence boundary

This gate detects automated axe rules, keyboard reachability, focus trapping, and the tested
Chromium journeys. It does **not** prove manual screen-reader usability, platform-specific assistive
technology behavior, or every WCAG success criterion. Those require separate human evidence before
a public release makes a broader accessibility claim.
