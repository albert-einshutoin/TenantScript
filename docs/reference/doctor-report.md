# Doctor report contract

`ext doctor --report <path>`は、self-host環境から別のtrusted adapterが収集したsecret-free snapshotを
決定的なfindingへ変換するoffline evaluatorです。Cloudflare API、D1、Durable Objects、secret storeへ接続せず、
このcommand単体の成功はlive deploymentの健全性を証明しません。live collectorとclean-account検証は
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34)の未完了範囲です。

## Version 1 compatibility schema

入力は次のfieldだけを持つclosed JSON objectです。binding、permission、secretはpresence/availabilityの
booleanだけを受け取り、値、URL、account ID、resource ID、provider error、自由記述messageを受け付けません。

```json
{
  "version": 1,
  "profile": "production",
  "bindings": {
    "DB": true,
    "ADMIN_MUTATION_RATE_LIMITER_DO": true
  },
  "migrations": {
    "expected": [1, 2, 3],
    "applied": [1, 2, 3]
  },
  "permissions": {
    "D1_READ": true,
    "D1_WRITE": true,
    "WORKERS_SCRIPTS_WRITE": true
  },
  "runtime": {
    "configured": "cloudflare-workers",
    "supported": ["cloudflare-workers"]
  },
  "secrets": {
    "ADMIN_CURSOR_SECRET": true
  }
}
```

version 1は互換性のために維持し、permissionの`true`を`granted`、`false`を`denied`として評価します。
permissionを確認できなかったcollectorが`false`へ丸める用途には使用しないでください。

version 1は`profile: production`だけを扱います。optional bindingを省略するlocal developmentやfixture環境は
このprofileのhealthy判定対象ではありません。

`expected`は1件以上、`applied`は空または`expected`の先頭から一致するstrictly increasingな正整数列です。
重複、逆順、未知migrationはschema errorです。runtime primitiveは`cloudflare-workers`、
`dynamic-workers`、`workers-for-platforms`だけを許可し、`supported`の重複や空配列を拒否します。
未知version、未知field、欠落field、型不一致もfail closedです。
reportの最大sizeは64 KiBです。上限を超えるfileは読み切らずschema errorにします。

## Version 2 permission evidence

version 2はversion 1と同じclosed fieldsを持ち、`permissions`だけを三値の証跡へ変更します。

```json
{
  "version": 2,
  "profile": "production",
  "bindings": {
    "DB": true,
    "ADMIN_MUTATION_RATE_LIMITER_DO": true
  },
  "migrations": {
    "expected": [1, 2, 3],
    "applied": [1, 2, 3]
  },
  "permissions": {
    "D1_READ": "granted",
    "D1_WRITE": "unverified",
    "WORKERS_SCRIPTS_WRITE": "denied"
  },
  "runtime": {
    "configured": "cloudflare-workers",
    "supported": ["cloudflare-workers"]
  },
  "secrets": {
    "ADMIN_CURSOR_SECRET": true
  }
}
```

- `granted`: collectorが必要な権限を確認した。
- `denied`: collectorが権限不足を確認した。
- `unverified`: read-only observationなどでは権限の有無を証明できなかった。

`unverified`は`granted`へ昇格せず、修復・追加確認が必要な独立findingとしてfail closedで扱います。
boolean、未知の文字列、追加fieldはversion 2ではschema errorです。
programmatic consumerはV1互換の`parseDoctorReport` / `evaluateDoctorReport`ではなく、追加APIの
`parseDoctorReportV2` / `evaluateDoctorReportV2`を使用します。

## Result and exit codes

stdoutは`version: 1`、`healthy`、`findings`を持つ1行JSONです。findingは次の固定順序で、stable `code`、
`severity`、`component`、入力を含まない`summary`、repository内の`repair` document pathだけを返します。

1. `doctor_binding_db_missing`
2. `doctor_binding_rate_limiter_missing`
3. `doctor_migrations_pending`
4. `doctor_permission_d1_read_missing`
5. `doctor_permission_d1_read_unverified`
6. `doctor_permission_d1_write_missing`
7. `doctor_permission_d1_write_unverified`
8. `doctor_permission_workers_scripts_write_missing`
9. `doctor_permission_workers_scripts_write_unverified`
10. `doctor_runtime_primitive_unsupported`
11. `doctor_secret_admin_cursor_missing`

各permissionは`missing`または`unverified`の一方だけを返し、permission間の順序は
`D1_READ`、`D1_WRITE`、`WORKERS_SCRIPTS_WRITE`で固定します。

exit `0`はfindingなし、exit `1`はvalid reportに修復対象あり、exit `2`はusage、read、JSON、schema errorです。
exit `2`のstderrは固定diagnosticだけを返し、入力pathやJSON内容を反射しません。

## Safe collection boundary

- collectorはsecret managerへ値ではなくpresenceだけを問い合わせます。
- reportをissue、CI artifact、support ticketへ添付する前に、closed parserを通します。
- account/resource IDやcredential付きURLが必要な調査は、公開reportとは別のprivate incident経路で扱います。
- findingの`repair` pathを正本として読み、provider error本文から生成したcommandを実行しません。
- report生成時刻やlive source provenanceはversion 1/2 schemaに含まれないため、古いreportを現在の状態とみなしません。

### Cloudflare read-only collector

`createCloudflareDoctorCollector`は既存の`CloudflareApiTransport`でWorker settingsを読み、注入された
migration history readerと合わせてclosed version 2 reportを生成します。`ADMIN_CURSOR_SECRET`は同じ
settings snapshot内の`secret_text` binding名からpresenceだけを導出します。既存integration向けの
`secretPresence` overrideも利用できますが、新規Cloudflare compositionでは省略して時点ずれを避けます。
provider responseからは対象bindingのpresenceだけを残し、database ID、Durable Object class、annotation、
secret value、provider error本文をreportやpublic errorへ渡しません。migration historyはrepository manifestの厳密なprefixだけを
受け付け、secret probeは`ADMIN_CURSOR_SECRET`のboolean presenceだけを返す必要があります。

CloudflareのD1 read endpointは`D1 Read`または`D1 Write`、Workerのread endpointもread/writeを含む複数の
permissionで成功できます。そのためread成功は個別permissionの証明ではありません。collectorは
`D1_READ`、`D1_WRITE`、`WORKERS_SCRIPTS_WRITE`を`unverified`として出力し、token policyを確認する将来の
authoritative collectorが追加されるまでhealthyへ昇格させません。これはcredentialed clean-account Tier 2の
代替ではなく、安全なsecret-free snapshot収集境界です。

実際のbinding要件は[configuration reference](configuration.md#control-plane-worker)、D1 routingは
[app database routing](../operations/app-database-routing.md)、rate limiterは
[admin mutation rate limits](../operations/admin-mutation-rate-limits.md)を参照してください。
