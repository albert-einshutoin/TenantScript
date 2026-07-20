# Control Plane success response schemas

Control Plane REST APIの成功statusとresponse bodyは、次の2つを公開契約として固定します。

- [`ADMIN_HTTP_ENDPOINT_CONTRACTS`](../../packages/control-plane/src/http-api.ts): endpoint methodごとの成功status、`json` / `none`、schema ID
- [`control-plane-success-responses.schema.json`](control-plane-success-responses.schema.json): schema IDごとのJSON Schema

JSON catalogはcredential、account、生成日時を含まないため、client生成、mock、contract testへそのまま
利用できます。npm利用者は`@tenantscript/control-plane`の
`CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS`から同じdeep-frozen catalogを参照できます。
JSON Schema側では各契約を`#/$defs/<schema ID>`で参照できます。

## 保証範囲

全16 endpoint・17 methodを対象にします。JSONを返す16 methodはbodyをschemaで検証し、
`DELETE /v1/admin/service-tokens`は`204`かつbodyなしとして固定します。同じpathでもPOSTとDELETEは
別契約です。

schemaは必須field、nested object/array、enum、integer下限、`additionalProperties: false`を明示します。
実HTTP handlerの成功fixtureをAjvで検証するため、catalogだけを更新して実装と乖離させることはできません。
検証はtest laneのみで行い、production request pathへvalidation costを追加しません。

エラーレスポンスは[Control Plane error catalog](control-plane-errors.md)が正本です。このsuccess catalogは
エラーcode、retryability、client actionを重複定義しません。

## 変更手順

1. handlerと型をTDDで変更する
2. `packages/control-plane/src/success-response-schemas.ts`を更新する
3. `pnpm control-plane-schema:write`で公開JSONを再生成する
4. 実レスポンスcontract testと`pnpm test:api-surface`を実行する
5. 互換性を判断し、Changesetを追加する

既存methodのstatus、body mode、schema ID、または既存schemaの内容を変えるとrelease policyは保守的に
breaking changeとして扱います。その場合は`@tenantscript/control-plane`のmajor Changesetと
`docs/migrations/`配下のmigration guideが必要です。新しいendpoint/schemaの追加はadditive changeです。
