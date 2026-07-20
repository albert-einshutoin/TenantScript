# Contributor test-selection matrix

変更した領域からRED/GREEN中の高速な反復コマンドを選ぶためのガイドです。focused testは
フィードバックを早めるためのもので、Pull Request前の最終 `pnpm verify` は必須です。
まず失敗する最小テストを確認し、実装後に同じtestをgreenにしてから追加gateと最終gateへ進みます。

## 変更領域ごとの選択表

すべてrepository rootから実行します。複数領域を変更した場合は、該当する各行のfocused testと
追加gateを組み合わせてください。単一fileへ絞る場合も、その領域のpackage testを最後に再実行します。

| 変更領域               | RED / GREENのfocused反復                                                                                                         | 追加するsecurity / integration / E2E                                                                                                                                                                                       | Pull Request前の最終gate |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **Docs**               | `pnpm test:docs`                                                                                                                 | `pnpm docs:check`、`pnpm format`、変更したguide内のcommand。security契約を変更する文書は`pnpm test:security`も実行する。                                                                                                   | `pnpm verify`            |
| **Manifest**           | `pnpm --filter @tenantscript/manifest test`                                                                                      | parser、未知field、境界値、secret非反射を変える場合は`pnpm --filter @tenantscript/manifest test:fuzz`も実行する。                                                                                                          | `pnpm verify`            |
| **SDK**                | plugin APIは`pnpm --filter @tenantscript/plugin-sdk test`、host hook/failure policyは`pnpm --filter @tenantscript/host-sdk test` | host parserやexecution planは`pnpm --filter @tenantscript/host-sdk test:fuzz`、failure/recoveryは`pnpm --filter @tenantscript/host-sdk test:chaos`を追加する。                                                             | `pnpm verify`            |
| **Capability**         | `pnpm --filter @tenantscript/capabilities test`                                                                                  | scope、egress、secret、provider side effect、auditを変更する場合は`pnpm --filter @tenantscript/capabilities test:security`を必ず追加する。                                                                                 | `pnpm verify`            |
| **Loader**             | `pnpm --filter @tenantscript/loader test`                                                                                        | isolation、binding、egress、limitsは`pnpm --filter @tenantscript/loader test:security`、timeoutやprovider failureは`pnpm --filter @tenantscript/loader test:chaos`を追加する。                                             | `pnpm verify`            |
| **Control plane**      | `pnpm --filter @tenantscript/control-plane test`                                                                                 | identity、tenant/app scope、D1/R2/DO、approval、rollback、auditは`pnpm --filter @tenantscript/control-plane test:security`を追加する。failure/recoveryは`pnpm --filter @tenantscript/control-plane test:chaos`も実行する。 | `pnpm verify`            |
| **Admin UI**           | `pnpm --filter @tenantscript/admin-ui test`                                                                                      | このcommandはVitestとPlaywright E2Eを含む。role、認証、privileged actionは`pnpm --filter @tenantscript/admin-ui test:security`も実行し、keyboard操作を変えたjourneyはPlaywrightで確認する。                                | `pnpm verify`            |
| **Proxy**              | `pnpm --filter @tenantscript/proxy test`                                                                                         | signature、forward先、header、tenant scope、fail-open/closed境界は`pnpm --filter @tenantscript/proxy test:security`を追加する。                                                                                            | `pnpm verify`            |
| **CLI**                | `pnpm --filter @tenantscript/cli test`                                                                                           | exit code、stdout JSON、stderr、secret非反射をtable-driven testで確認する。公開command例を変えた場合は`pnpm test:docs`も実行する。                                                                                         | `pnpm verify`            |
| **Security-sensitive** | 変更packageのfocused testに加えて`pnpm test:security`                                                                            | secret exposure、egress bypass、grant escalation、tenant越境、approval権限、audit mutationのadversarial caseを追加する。security programや公開証跡の変更は`pnpm test:security-program`も実行する。                         | `pnpm verify`            |

## 追加gateを選ぶ基準

- 公開型、manifest schema、HTTP response、CLI exit codeを変える場合は、呼び出し側と公開docsの
  contract testも更新します。
- D1、R2、Durable Objects、Worker bindingを変える場合は、plain Vitestだけで終えず、該当packageの
  workerd-backed testを含むpackage `test` / `test:security`を実行します。
- user journey、keyboard操作、表示する権限を変える場合はAdmin UIのPlaywright E2Eとsecurity testを
  両方実行します。
- timeoutやretryを検証するために固定時間待機を追加しません。fake clock、明示的なpromise、保存済み
  状態など決定論的な同期点を使います。

## Tier 1とTier 2の境界

**Tier 1 accountless**はすべてのPull Requestとforkで実行できる必須gateです。`pnpm verify`と
`accountless quality gate`はCloudflare、npm、GitHubの書込みcredentialを要求しません。

**Tier 2 live** testsはCloudflare credentialやsecret、実行costを必要とし、maintainer管理の
scheduleまたは手動実行だけで行います。fork contributorにTier 2を要求せず、資格情報不足を理由に
Tier 1のtestをskipしません。live evidenceが必要な変更は、IssueとPull Requestに未完了の外部gateを
明記し、repository testのgreenをlive verifiedと表現しないでください。

## 完了チェック

1. REDで期待した理由による失敗を確認した。
2. GREEN後に変更領域のfocused testが通る。
3. 表に該当するsecurity、integration、E2E、fuzz、chaos testを通した。
4. `pnpm verify`を最終必須gateとして通した。
5. Pull RequestへRED/GREENと実行した正確なcommand、Tier 2など未完了の外部検証を記載した。
