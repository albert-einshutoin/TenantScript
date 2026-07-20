# Rollback Troubleshooting

壊れたplugin versionを検知してから、既知の正常versionへ戻し、次のexecutionで復旧を確認するまでの運用手順。manager roleのAdmin UIを標準経路、CLIをUIへ到達できない場合のfallbackとする。

## 事前条件

- installation ID、現在version、最後に正常だったversionを把握している
- manager tokenを使用する。viewerはrollback操作を表示されず、直接APIも`403 rollback_forbidden`になる
- token、config、grant、customer payloadをチケットやdrill証跡へ貼らない
- 復旧中に同じinstallationへ別のversion変更を並行実行しない

ローカルでrollback契約とdrill計測を確認する。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli exec vitest run test/rollback.test.ts test/rollback-drill.test.ts
```

## 1. 壊れたversionを特定する

Admin UIの**Executions**でtenant scope内の失敗を絞り込み、installation、plugin、version、hook、safe error codeを記録する。秘密値やpayload本文ではなくexecution IDをインシデント記録の参照キーにする。

次を先に切り分ける。

| 症状                         | 判断                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| 同じversionへの切替を要求    | 操作ミス。別の既知正常versionを選ぶ                                          |
| target versionが見つからない | tenant/plugin/installationの組み合わせを再確認                               |
| revision conflict            | 別の変更が先に完了。画面を再読込し、現在versionとrevisionから判断し直す      |
| managerでも403               | tokenのapp/tenant/role claimを確認。request bodyでroleを指定しても昇格しない |
| 429                          | mutation rate limit。`Retry-After`後に同じ意図を再試行する                   |

## 2. Admin UIからrollbackする

1. **Versions**で対象installationを開く。
2. 現在versionと最後に正常だったtarget versionを比較する。
3. **Rollback**を選び、確認ダイアログのtenant、plugin、current、targetを照合する。
4. `rollbackStartedAt`を記録して**Confirm rollback**を実行する。
5. **Rollback completed**のrevision、audit ID、server completion timestampを記録する。

UIは現在のrevisionを使ったcompare-and-swapを行う。競合時は古い確認画面のまま再送せず、再読込して別の変更を確認する。

## 3. 応答を失った場合

timeoutやnetwork切断では、成功した処理を重複させないため、同じrollback意図に同じ`Idempotency-Key`を再利用する。Control Planeは同じrequestを保存済みresultへ解決する。

- 同じkeyでtargetやrevisionを変えない。異なる意図は`409`になる
- targetを変える場合は最新revisionを読み直し、新しいkeyを発行する
- audit IDを取得できたら、そのIDをcanonical resultとして記録する

詳細契約は[Admin rollback idempotency](admin-rollback-idempotency.md)を参照する。

## 4. CLI fallback

Admin UIに到達できない場合のみ、CLIの同じrollback契約を使う。実行前にapp、plugin、installation、target version、audit IDをインシデント記録と照合する。

```text
ext rollback --installation <installation-id> --target-version <known-good-version-id> --expected-revision <current-revision> --idempotency-key <stable-request-key>
```

Set `TENANTSCRIPT_CONTROL_PLANE_URL` and the secret `TENANTSCRIPT_CONTROL_PLANE_TOKEN` through the
operator-controlled environment before running the command. The token identity supplies app,
tenant, and actor authority; the CLI deliberately rejects those values as flags. Reuse the same
16–128 character idempotency key only when reconciling the exact same intent after an ambiguous
response. The CLI never retries a mutation automatically.

CLIの引数検証、HTTP error、出力契約はrepository testで再現できる。tokenをコマンドライン引数やshell historyへ含めない。

## 5. 復旧を確認する

rollback成功レスポンスだけで復旧完了としない。**View execution log**から次の実eventを確認し、以下を満たすexecution IDを記録する。

- versionがtarget versionである
- statusが期待値である
- capability callが重複していない
- 同じeventがretryされた場合もjournalにより副作用が再送されていない

復旧しない場合は、installationがenabledか、budget超過でauto-disableされていないか、target versionのmanifest/grant/configが現在環境と互換かを確認する。原因がversion以外ならrollbackを反復せず、installation disableなど影響封じ込めを優先する。

## 6. MTTR drillを記録する

本番または本番相当環境で取得した4時刻をcanonical validatorへ渡す。次はrepository内の既知fixtureで、期待exitは0、MTTRは3分20秒である。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli rollback:drill -- \
  --deployed-at 2026-06-13T00:00:00.000Z \
  --detected-at 2026-06-13T00:01:15.000Z \
  --rollback-started-at 2026-06-13T00:02:00.000Z \
  --completed-at 2026-06-13T00:03:20.000Z
```

drill証跡には時刻、from/to version、audit ID、復旧確認execution IDだけを保存する。記録形式とPhase 1の5分gateは[Phase 1 rollback drill](../benchmarks/phase1-rollback-drill.md)を参照する。

## 再発防止

- deploy前に`ext schema diff`、manifest lint、dry-run artifact hashを確認する
- production切替前に`ext replay`で結果とcapability call差分を比較する
- 段階的にinstallationを切り替え、失敗率とbudgetを監視する
- incident後に検知遅延、rollback遅延、revision conflict、runbook不足を分けて振り返る
