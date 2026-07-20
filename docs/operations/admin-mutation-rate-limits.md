# Admin mutation rate limits

TenantScriptのControl Planeは、管理者トークンが漏えいした場合や自動化が暴走した場合にも、変更と監査イベントが無制限に生成されないよう、Admin変更APIをDurable Objectの固定窓カウンタで制限する。

## 適用範囲

`installation-command`、`installation-create`、`rollback`、`approval-decision`を個別のcommand familyとして扱う。バケットはapp、tenant、actor、command familyの組み合わせごとに分離し、Durable Object名にはそれらのSHA-256 digestだけを使用する。Bearer tokenはキーにも保存値にも含めない。

制限器が未構成または利用不能な場合、権限変更は`503`でfail closedする。超過時はDB変更・監査書込みの前に`429`、`Cache-Control: no-store`、秒数形式の`Retry-After`を返す。Admin UIは変更を自動再送せず、利用者に再試行可能時間を示すため、二重変更や同時再送バーストを作らない。

## Worker binding

Workerから`AdminMutationRateLimitDurableObject`をexportし、Durable Object namespaceを`ADMIN_MUTATION_RATE_LIMITER_DO`としてbindingする。namespace lifecycleは独立resourceではなく、Control Plane Workerのdeployに含める。新規namespaceはCloudflareの[Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)契約に従い、Wranglerのdeclarative `exports`でSQLite storageを明示する。

```jsonc
{
  "durable_objects": {
    "bindings": [
      {
        "name": "ADMIN_MUTATION_RATE_LIMITER_DO",
        "class_name": "AdminMutationRateLimitDurableObject"
      }
    ]
  },
  "exports": {
    "AdminMutationRateLimitDurableObject": {
      "type": "durable-object",
      "storage": "sqlite"
    }
  }
}
```

`exports`とlegacy `migrations` arrayは同時に使用しない。既存のTenantScript namespaceは
`new_sqlite_classes`で作成されていたため、`storage: "sqlite"`を維持する。classの削除は
namespace内の全データを恒久削除する明示的tombstone操作であり、setup失敗時の自動rollbackには
含めない。Worker削除だけをDurable Objectデータ削除の成功証跡として扱ってはならない。

設定値は以下のWorker text bindingで上書きできる。未設定時は安全な既定値を使い、不正・ゼロ・負数・過大値はWorker全体で安定した`503`に閉じる。

| Binding                              | Default | Allowed range |
| ------------------------------------ | ------: | ------------: |
| `ADMIN_MUTATION_RATE_LIMIT`          |      20 |      1–10,000 |
| `ADMIN_MUTATION_RATE_WINDOW_SECONDS` |      60 |      1–86,400 |

本番値を変える場合は、通常の管理操作量、漏えい時に許容できる変更量、監査保存量を合わせてレビューする。制限を緩めるためにbindingやfail-closed処理を外してはならない。
