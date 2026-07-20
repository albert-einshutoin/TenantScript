# Good-first-issue pipeline

TenantScript applies `good first issue` only when the security and package boundary is narrow, the
expected files are known, and completion can be proved without maintainer credentials.

## Current issues

| Issue                                                                                         | Area          | Why it matters                                                 |
| --------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------- |
| [#144 Glossary](https://github.com/albert-einshutoin/TenantScript/issues/144)                 | Docs          | Prevents security-sensitive domain terms from being conflated. |
| [#145 Configuration reference](https://github.com/albert-einshutoin/TenantScript/issues/145)  | Self-host     | Gives operators one redacted configuration source of truth.    |
| [#146 CLI reference](https://github.com/albert-einshutoin/TenantScript/issues/146)            | CLI           | Documents contracts used by people and agents.                 |
| [#147 API error catalog](https://github.com/albert-einshutoin/TenantScript/issues/147)        | API           | Prevents clients from parsing messages or leaked details.      |
| [#148 Test-selection matrix](https://github.com/albert-einshutoin/TenantScript/issues/148)    | CI            | Supports fast iteration without skipping the final gate.       |
| [#149 Troubleshooting index](https://github.com/albert-einshutoin/TenantScript/issues/149)    | Operations    | Routes symptoms to safe runbooks.                              |
| [#150 Docs landing page](https://github.com/albert-einshutoin/TenantScript/issues/150)        | Community     | Gives each audience a short route to its source of truth.      |
| [#151 Manifest rejection tests](https://github.com/albert-einshutoin/TenantScript/issues/151) | Security      | Locks down an untrusted input boundary.                        |
| [#152 CLI failure JSON tests](https://github.com/albert-einshutoin/TenantScript/issues/152)   | CLI           | Keeps automation output stable and free of secrets.            |
| [#153 Admin skip link](https://github.com/albert-einshutoin/TenantScript/issues/153)          | Accessibility | Removes repeated navigation for keyboard users.                |

## Required issue quality

Every linked issue states its goal, expected files, implementation approach, security or
compatibility cautions, RED/TDD starting point, Verification commands, and Definition of Done. A
maintainer removes the label if discovery makes a task architectural, credential-dependent, or
unsafe for independent implementation.

## Verification

```sh
# cwd: repository root
# expected-exit: 0
gh issue list --state open --label "good first issue" --limit 100
pnpm test:community-governance
```

## Definition of Done for pipeline changes

- At least ten open, non-duplicate issues retain the `good first issue` label.
- Every issue includes why, how, cautions, files, RED, verification, goal, and quality criteria.
- No issue requires Cloudflare, npm, customer, or private maintainer credentials.
- Closed or expanded issues are removed or replaced in this index.
