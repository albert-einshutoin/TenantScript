# Self-host setup plan contract

`ext setup --profile production --runtime <primitive> --dry-run true`は、TenantScriptのproduction self-hostに
必要なCloudflare resource、logical permission、cost dimension、cleanup順序を事前レビューするaccountless plannerです。
Cloudflare API、credential、account IDを使わず、resource作成やmigration適用も行いません。

## Explicit runtime selection

`--runtime`は`cloudflare-workers`、`dynamic-workers`、`workers-for-platforms`のいずれかを必須指定します。
[ADR-001](../adr/001-runtime-primitive.md)のlive比較が未完了のため、CLIはdefaultを選びません。
Workers for Platformsを選ぶ場合、Workflowsはnamespace内へdeployできないため、別のControl Plane Workerへ
配置するwarningを出します。

## Version 1 operations

operationは次の固定順序です。`implementationStatus: implemented`はaccountless library/runtime adapterが存在すること、
`integration-required`はproduction Worker wiringまたはlive adapterが未完了であることを示します。resourceがliveで
利用可能という証明ではありません。

1. Control Plane D1を作成する。
2. app単位D1 provisioning boundaryを宣言する。具体的なapp databaseはapp onboarding時に作成する。
3. plugin artifact用R2 bucketを作成する。
4. execution archive用R2 bucketを作成する。
5. provider secret storeのDurable Object binding/class lifecycleをControl Plane Workerへ宣言する。
6. approval lifecycleのWorkflowを作成する。
7. usage meterのWorkers Analytics Engine bindingを宣言する。datasetは初回write時にCloudflareが作成する。
8. 明示選択したtenant runtime Worker/dispatch boundaryを作成する。
9. Control Plane D1 migrationを適用する。
10. resourceをbindするControl Plane Workerを、selected runtime Workerとは別のownership resourceとして作成または明示adoptする。Admin mutation rate limiterとprovider secret storeのDurable Object lifecycleもこのWorker deployへ集約する。

各operationはstable ID、resource kind、action、logical name、implementation status、dependency IDだけを持ちます。
Cloudflare resource IDや実account由来の名前を含みません。同じruntime入力はbyte-identicalなJSONを返します。

## Permissions

planは`workers:write`、`d1:write`、`r2:write`、`durable-objects:write`、`workflows:write`、
`analytics-engine:write`をlogical capabilityとして列挙します。これはCloudflare API tokenの正確なpermission名を
保証するものではありません。live adapterは実行時の公式permission modelへ最小権限で対応付け、token値や
permission response本文をplanへ出してはいけません。

## Cost boundary

金額、free allowance、将来の課金開始日をplanへ固定しません。各serviceはmetering dimension、availability note、
公式pricing URL、`verifyBeforeApply: true`を返します。apply前に必ず最新の公式ページを確認してください。

- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/)
- [Workers for Platforms reference](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)
- [Workers Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)

## Cleanup and failure boundary

cleanup planは`action: create`のresourceだけを作成順の逆順で列挙し、すべて
`onlyIfCreatedBySetup: true`です。Control Plane Workerは依存resourceより後に作成し、cleanupでは最初に扱います。
app database declarationとmigrationは削除対象にしません。
live adapterはrun journalで「今回新規作成した」ことを証明できるresourceだけを削除し、既存/adopted resourceを
削除してはいけません。D1と2つのR2 operationにはaccountless adapterがあり、R2はbucketを空にする処理や
lifecycle ruleを扱いません。Analytics Engineとprovider secret store Durable Objectはbinding宣言であり、独立resource cleanupへ含めません。secret-store classの削除は全provider token dataを永久破棄するdestructive tombstoneなのでoperator-owned manual operationです。
dry-runはcleanupを実行しません。

Durable Object classはWorker code、binding、`exports` declarationをdeploy時に照合して初回
provisioningと後続lifecycleを管理します。削除tombstoneはnamespace内のdataを永久に破棄するため、通常cleanupに
変換しません。

- [Cloudflare Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)

version 1 plan自体にはlive create/update/delete、existing resource adoption、migration apply、rollback journal、
clean-account E2Eは含まれません。これらの一部には注入可能なaccountless adapterがありますが、CLI live commandへ
結線されていません。Control Plane Worker operationはownershipとcleanup順をモデル化し、remote Worker adapterは
accountless実装済みですが、credential-bearing CLI compositionとlive削除証跡は未完了です。
`cloudflare-workers`向けのWrangler生成は
[production self-host baseline](../operations/self-host-production.md)で提供します。JSONの
`liveValidationRequired: true`とwarningは、このplanを
Tier 2または本番成功証跡として扱えないことを明示します。残作業は
[Issue #34](https://github.com/albert-einshutoin/TenantScript/issues/34)で追跡します。
