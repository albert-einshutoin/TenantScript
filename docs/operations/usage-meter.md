# Usage meter operations

TenantScriptのusage meterは課金機能ではなく、self-host adopterがexecutionのCloudflare利用量を把握するためのCOGS観測境界である。

## Recorded schema

`createAnalyticsEngineUsageSink`は1 executionにつき1 data pointを書き込む。位置は固定である。

| Analytics Engine field | Value                                        |
| ---------------------- | -------------------------------------------- |
| `index1`               | `tenantId:pluginId`                          |
| `blob1`                | tenant ID                                    |
| `blob2`                | plugin ID                                    |
| `blob3`                | hook type (`event` / `transform` / `policy`) |
| `blob4`                | execution status                             |
| `double1`              | executions (`1`)                             |
| `double2`              | CPU milliseconds                             |
| `double3`              | subrequests                                  |
| `double4`              | workflow runs                                |

`executionId`、hook名、payload、config、secret、token、provider errorはAnalytics Engineへ書き込まない。meterは入力オブジェクトをそのまま渡さず、固定shapeの`UsageEvent`を生成してsink境界を越える。

## Failure policy

Analytics Engineはexecution authorityではないため、sink書き込み失敗はfail-openで扱う。日次summaryは更新し、plugin executionの成功・失敗を変更しない。内部failure reporterへ渡す値も固定された`usage_sink_write_failed`、tenant ID、plugin IDだけで、provider error本文は渡さない。failure reporter自身の失敗もexecutionへ伝播しない。

## UTC aggregation contract

`ControlPlaneApi.getDailyUsageSummaries`は以下で日次summaryを取得する。

```ts
await api.getDailyUsageSummaries({
  tenantId: "tenant_acme",
  pluginId: "invoice-policy", // optional
  fromDate: "2026-07-01",
  toDate: "2026-07-31"
});
```

同じcontractはtenant-scoped Admin endpointでも提供する。

```http
GET /v1/admin/usage?pluginId=invoice-policy&fromDate=2026-07-01&toDate=2026-07-31
Authorization: Bearer <viewer-or-manager-token>
```

HTTP requestの`tenantId`は使用せず、tenant scopeは常に認証identityから導出する。不正な日付や期間は値を反射せず`400 invalid_usage_query`、meter未設定時は`503 usage_meter_unavailable`を返す。

- `tenantId`は必須で、別tenantのsummaryを混在させない。
- `pluginId`を省略するとtenant内の全pluginを返す。
- 日付はUTCの`YYYY-MM-DD`、両端を含む。
- 無制限scanを避けるため1 requestは最大366日である。
- 結果は日付、plugin IDの順で決定論的に並ぶ。

## Verification

Tier 1はAnalytics Engine bindingを使わず、adapter contract、fail-open、固定field projection、tenant/plugin/date rangeを検証する。

```sh
pnpm --filter @tenantscript/control-plane test
pnpm test:security
```

実bindingのdata point到達とCloudflare側queryはaccount IDとAPI tokenを必要とするためTier 2 follow-upである。self-host環境へbindingを設定した後、secretをrepositoryへ保存せず、staging execution 1件の固定fieldとUTC日次集計だけを確認する。
