# Operator troubleshooting index

Self-host operatorが症状から安全な初動と正本runbookへ進むための索引です。ここにある初動は
状態を変更しない観測に限定しています。復旧操作はリンク先の権限、tenant/app scope、冪等性、
監査契約を確認してから実行してください。

## 症状から調べる

| 症状                    | 最初の安全な観測点                                                                                                                                                                                   | Runbook                                                                                                                                                                                                                                                        | 初動で行わないこと                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Install failure**     | **安全な観測 (safe observation):** HTTP statusとstable error code、認証identityのapp/tenant、対象appのD1 binding名、同じ`Idempotency-Key`で保存済みresultが返るかを記録する。値やtokenは記録しない。 | [Admin install idempotency](admin-install-idempotency.md)で再試行契約を、[App database routing](app-database-routing.md)でapp単位D1とfail-closed設定を確認する。grant承認が関係する場合は[Installation grant approval](installation-grant-approval.md)へ進む。 | 新しいkeyで反復実行、別appのDBへfallback、手動insertをしない。                                |
| **Approval stalled**    | **安全な観測 (safe observation):** request ID、app/tenant/installation、現在のdecision数、必要threshold、expiry、actor roleをAdmin APIのread結果と監査イベントで照合する。                           | [Installation grant approval](installation-grant-approval.md)でrole、threshold、expiry、原子的確定、migration順序を確認する。                                                                                                                                  | operatorによる自己承認、期限やthresholdの書換え、監査を迂回したinstallをしない。              |
| **Rollback**            | **安全な観測 (safe observation):** 現在version/revision、既知の正常version、audit ID、最後のexecutionを読み取り、応答喪失時は元の`Idempotency-Key`を保持する。                                       | [Rollback troubleshooting](rollback-troubleshooting.md)で検知から復旧確認までを、[Admin rollback idempotency](admin-rollback-idempotency.md)で安全な結果再取得を確認する。                                                                                     | 成功応答だけで復旧完了と判断、新しいkeyでの盲目的再試行、revision競合の上書きをしない。       |
| **Rate limit**          | **安全な観測 (safe observation):** `429`と`Retry-After`、command family、認証済みapp/tenant/actor scopeを記録し、他scopeのbucketと混同していないか確認する。                                         | [Admin mutation rate limits](admin-mutation-rate-limits.md)でbucket分離、binding、fail-closed、設定範囲を確認する。                                                                                                                                            | tokenをbucket keyへ含める、制限を回避するactor切替、無制限retryをしない。                     |
| **Archive**             | **安全な観測 (safe observation):** retention cutoff、archive object key、件数、checksum/signature検証結果を読み取り、hot dataとarchiveの境界を記録する。                                             | [Execution retention](execution-retention.md)でD1/R2 lifecycleを、[Audit export](audit-export.md)で最小化、manifest、署名検証を確認する。                                                                                                                      | 原本削除を先行、checksum不一致を無視、customer payloadをissueへ添付しない。                   |
| **Migration**           | **安全な観測 (safe observation):** schema version、利用中hook schema、互換性判定、migration適用履歴をread endpointとCI diffで照合する。                                                              | [Schema migrations](schema-migrations.md)で利用追跡、廃止gate、role境界、適用順序を確認する。                                                                                                                                                                  | 利用中schemaの強制削除、履歴テーブルの手動修正、未確認migrationの一括適用をしない。           |
| **Runaway**             | **安全な観測 (safe observation):** 連続失敗、timeout、budget、quarantine状態、影響scope、直近execution IDを取得し、incident ownerを決める。                                                          | [Runaway quarantine](runaway-quarantine.md)で自動隔離と明示復旧を、[Incident response](incident-response.md)で封じ込め、証跡、復旧判断を確認する。                                                                                                             | quarantine解除の反復、budget guardの無効化、影響不明のまま全installationを変更しない。        |
| **Telemetry failure**   | **安全な観測 (safe observation):** opt-in設定、scheduled runの結果、集計event名、receiver到達性を確認し、plugin実行や認可が継続していることを別に確認する。                                          | [Telemetry and privacy](../privacy/telemetry.md)でdefault-off、匿名化、送信先、fail-open境界を確認する。                                                                                                                                                       | telemetry復旧のためにplugin実行を停止、raw identifierを送信、非公開receiverを文書へ貼らない。 |
| **Secret key rotation** | **安全な観測 (safe observation):** secret ref inventory、key ID別件数、未解決競合、secret-freeなread検証結果を確認する。key materialとtokenは表示しない。                                            | [Secret KEK rotation](secret-key-rotation.md)で二段階deploy、CAS rewrap、rollback、旧鍵の退役条件を確認する。                                                                                                                                                  | 旧鍵の先行削除、envelopeの手動編集、非transactionalな`get` + `put`、無制限retryをしない。     |

stable error codeから調べる場合は[Control Plane HTTP error catalog](../reference/control-plane-errors.md)を
併用してください。複数tenant、security boundary、audit integrityへ影響する兆候がある場合は、個別の
復旧操作より先に[Incident response](incident-response.md)の封じ込めへ進みます。

## 禁止する復旧ショートカット

- **destructive SQL**（`DROP`、証跡の直接`DELETE`、履歴の書換え）で状態を合わせない。必要な
  migrationや管理APIがない場合は、incidentとして保存して実装Issueへ切り出す。
- shared branchやrelease tagを**force-push**しない。復旧手順とコード変更は短命branchとPull
  Requestに残し、監査可能な履歴を保つ。
- raw secrets、Bearer token、customer payload、実在tenant/account ID、private URLをissue、
  Pull Request、chat、logへ貼らない。識別子はsynthetic placeholder、値はredacted metadataにする。
- 監査記録を削除・迂回して自動復旧を成立させない。audit、隔離、approval、tenant境界を保った
  手順が存在しない場合は、変更を止めてincident ownerとsecurity maintainerへ引き上げる。

## 検証状態

この索引とリンク整合性、synthetic incident drillはrepositoryのTier 1で検証されます。これは外部の
Cloudflare環境で各障害をlive検証した証拠ではありません。live evidenceと外部blockerは
[Phase 2 gate evidence](../reviews/phase2-gate-evidence.md)で区別してください。

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:docs
pnpm lint:docs
pnpm lint:incident-drills
```
