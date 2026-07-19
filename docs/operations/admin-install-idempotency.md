# Admin installation idempotency

`POST /v1/admin/installations`は、応答喪失、プロキシ再送、複数タブからの再試行でもinstallationと監査イベントを一度だけ確定する。

## Client contract

各install操作に、暗号学的乱数から生成した16〜128文字の`Idempotency-Key` headerを付ける。使用できる文字は英数字と`._~-`である。UUID v4を推奨する。

```http
POST /v1/admin/installations HTTP/1.1
Authorization: Bearer <manager token>
Idempotency-Key: 5c6bde55-51a7-4ab5-a33e-b95c5af5f58f
Content-Type: application/json
```

- 応答を受信できなかった場合は、同じ操作内容と同じkeyで再送する。
- 同じtenant・同じkey・同じ内容なら、追加のinstallationやauditを作らず、最初に保存した安全なresultを返す。
- 同じtenant・同じkeyで内容を変更すると`409 idempotency_key_reused`になる。新しい意図には新しいkeyを使う。
- app、tenant、actorは認証identityからのみ導出される。keyやbodyでscopeを指定できない。

Admin UIはinstall dialogを開いた操作意図ごとにkeyを生成し、結果確定まで同じkeyを保持する。mutationを自動再送しないため、利用者がnetwork failureを確認して明示的に再試行できる。

## Storage and retention

Control Planeはcanonical requestのSHA-256 hashと、config・grant・manifest・tokenを含まない安全なresultだけをD1に保存する。config objectのkey順とcapability配列順はhashへ影響しない。

installation、append-only audit、idempotency recordは同一D1 batchで原子的に確定する。並行要求でunique key競合が起きた場合、敗者のbatchはrollbackされ、勝者のresultを再読込する。

recordの保存期間はControl Planeの時刻を基準に24時間とする。期限切れkeyは次の同一scope操作で原子的に置き換えられる。運用者はこの期間内の再試行に同じkeyを使用し、request bodyやhashをログへ出力してはならない。
