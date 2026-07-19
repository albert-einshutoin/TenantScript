# Admin rollback idempotency

`POST /v1/admin/rollbacks`は、version pinとappend-only auditの確定後に応答が失われても、同じrollback結果を安全に再取得できる。

## Client contract

rollback操作ごとにUUID v4などの暗号学的乱数から16〜128文字の`Idempotency-Key`を生成する。使用可能文字は英数字と`._~-`である。

```http
POST /v1/admin/rollbacks HTTP/1.1
Authorization: Bearer <manager token>
Idempotency-Key: 094d4150-2431-48ab-b33c-cd99c4997714
Content-Type: application/json
```

- 応答喪失後は同じkey、`installationId`、`targetVersionId`、`expectedRevision`で再送する。
- 同じtenant・key・内容なら、追加更新や追加auditなしで最初の`revision`、`auditId`、`completedAt`を返す。
- 同じkeyでrollback内容を変えると`409 idempotency_key_reused`になる。
- tenant、app、actorは認証identityからのみ導出する。別tenantの同じkeyは独立し、他tenantの結果を返さない。

Admin UIはrollback確認対象を選択した時点でkeyを生成し、成功または明示キャンセルまで保持する。mutationは自動再送せず、応答喪失後の明示的な再試行だけが同じkeyを使う。

## Atomicity and retention

Control Planeはrollback requestのSHA-256 fingerprintと、version、revision、audit ID、完了時刻だけを含む安全なresultをD1へ保存する。config、grant、token、顧客payloadはfingerprint入力・result・HTTP errorへ含めない。

revision CASを適用するaudit insertとidempotency recordは同じD1 batchで確定する。並行する同一keyの敗者はbatch全体をrollbackし、勝者の保存結果を再読込する。idempotency保存に失敗した場合もversion pinとauditは残らない。

保存期間はControl Planeの時刻を基準に24時間である。期限内の再試行は同じkeyを使い、新しいrollback意図には必ず新しいkeyを生成する。期限切れrecordは次の同一scope操作で原子的に置き換えられる。
