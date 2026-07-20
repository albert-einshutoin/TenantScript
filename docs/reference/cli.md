# CLI command and exit-code reference

`ext`はTenantScriptのplugin作成、local検証、schema/manifest検査、運用操作をJSONで自動化する
CLIです。このreferenceは`packages/cli/src/index.ts`とCLI testsに存在するcommandだけを掲載します。

## Output and exit contract

- 成功結果と機械判定するvalidation結果は1行のJSONとしてstdoutへ出力します。
- command usage、入力file、local runtime、Control Plane requestの診断はstderrへ出力します。
- `0`はcommandが完了したことを示します。`schema diff`のcompatible、`manifest lint`のvalid、
  `rollback-drill`のmeasurement完了も`0`です。drillの`passed: false`は測定結果でありexit failureでは
  ありません。
- `1`はvalidなcommandが実行またはcontract判定で失敗したことを示します。schema breaking change、
  invalid manifest、doctor finding、bundle/runtime failure、未構成client、Control Plane failureが該当します。
- `2`はcommand/action/option/inputのusage errorです。`init`の安全なscaffold拒否と
  `rollback-drill`の時系列不正も、実装上は修正可能な入力エラーとして`2`です。

provider error detail、raw response body、token、secret、customer payloadをautomation logへ保存しないで
ください。現行HTTP clientが返すdiagnosticは信頼できる公開error contractとは限らないため、公開CIでは
stderrをそのまま転載せず、exit codeとredacted contextだけを記録します。

## Commands

「必須」列にないoptionは任意またはdefault付きです。全optionは`--name value`形式で渡します。

| Command                  | 用途                                                                       | 必須action / option                                                              | JSON output                                                                              | Tested exit codes                                                            | 関連ガイド / 制約                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`ext init`**           | 空directoryへ安全なplugin scaffoldを生成する。                             | `--name`、`--dir`                                                                | JSON: `name`、absolute `directory`、生成`files`                                          | `0` success、`2` usage/scaffold refusal                                      | `--hook` defaultは`invoice.created`、`--type` defaultは`event`。TenantScript SDKはCLIと同じexact version。既存fileを上書きしない。                                                        |
| **`ext build`**          | entryを決定論的にbundleしartifactを書く。                                  | `--entry`                                                                        | JSON: `entry`、`out`、`sha256`、`bytes`                                                  | `0` success、`1` build/write failure、`2` usage                              | `--out` defaultは`dist/plugin.cjs`。[SDK reference](sdk.md)も参照。                                                                                                                       |
| **`ext dev`**            | scoped local loaderで1 hookを実行する。                                    | `--entry`、`--hook`                                                              | JSON: `hookName`、`value`、sanitized `logs`                                              | `0` success、`1` bundle/runtime failure、`2` usage                           | `--payload` defaultは`{}`。local capabilityはsyntheticでありprovider credentialを使わない。                                                                                               |
| **`ext replay`**         | 保存済みsynthetic sampleを再実行しprevious/replay差分を得る。              | `--entry`、`--sample`                                                            | JSON: `executionId`、`hookName`、`previous`、`replay`、`diff`                            | `0` success、`1` I/O/bundle/runtime failure、`2` usage/invalid sample        | sampleへsecretやcustomer payloadを保存しない。[Rollback troubleshooting](../operations/rollback-troubleshooting.md)も参照。                                                               |
| **`ext schema`**         | `diff` actionでhook schema互換性を判定する。                               | `diff`、`--from`、`--to`                                                         | JSON: `compatible`、`breaking`、`warnings`                                               | `0` compatible、`1` breaking/read failure、`2` usage                         | [Schema diff in CI](schema-diff-ci.md)がCI契約とmigration順序の正本。                                                                                                                     |
| **`ext manifest`**       | `lint` actionでmanifestをclosed schemaに照合する。                         | `lint`、`--manifest`                                                             | JSON: valid時は`ok`、`name`、`version`、`hooks`。invalid時は`ok: false`とstable `errors` | `0` valid、`1` invalid/read failure、`2` usage                               | errorにはpathとmessageだけを使い、入力値やsecretを反射しない。                                                                                                                            |
| **`ext deploy`**         | manifestとbundleを検証し、dry-run metadataまたは登録結果を返す。           | `--app`、`--plugin`、`--version`、`--entry`、`--manifest`                        | JSON: `dryRun`、version、`artifactHash`、必要最小限のmanifest/登録ID                     | `0` success、`1` validation/build/client failure、`2` usage/version mismatch | 公開`ext` binaryで完結するdeploy経路は`--dry-run true`。live登録用`DeployClient`はlibrary注入のみで、binaryには未配線。                                                                   |
| **`ext rollback-drill`** | deployから復旧までの時刻を測りMTTR gateを計算する。                        | `--deployed-at`、`--detected-at`、`--rollback-started-at`、`--completed-at`      | JSON: ISO時刻、`detectionMs`、`rollbackMs`、`mttrMs`、`thresholdMs`、`passed`            | `0` measured、`2` usage/timestamp order                                      | `--threshold-ms` defaultは300000。[Phase 1 rollback drill](../benchmarks/phase1-rollback-drill.md)を参照。                                                                                |
| **`ext doctor`**         | secret-freeなself-host診断reportを決定的に評価する。                       | `--report`                                                                       | JSON: `version`、`healthy`、stable `findings`                                            | `0` healthy、`1` repair required、`2` usage/read/schema failure              | [Doctor report contract](doctor-report.md)がschemaとoffline/live境界の正本。入力値をdiagnosticへ反射しない。                                                                              |
| **`ext setup`**          | production self-hostのresource plan、または最小Wrangler configを生成する。 | `--profile`、`--runtime`、`--dry-run`、任意`--wrangler-input`・`--output`        | JSON: plan、または実装済みbindingだけのWrangler config                                   | `0` planned/generated、`2` invalid input/read/write/unsupported live apply   | version 1は`production`と`--dry-run true`だけ。Wrangler生成は`cloudflare-workers`限定でexact-schema入力、credential非受理、既存file非上書き。[Setup plan contract](setup-plan.md)を参照。 |
| **`ext approvals`**      | shipped Admin Workerへ`approve`または`reject` decisionを送る。             | `approve` / `reject`、`--approval`                                               | JSON: `approvalId`、`state`、`auditId`、`decidedAt`、任意の`installation`                | `0` success、`1` client/request failure、`2` usage                           | `--reason`は任意。app、tenant、actorはBearer identityだけから決まり、CLI flagでは受け付けない。URLとtokenの両設定が必要。                                                                 |
| **`ext rollback`**       | shipped Admin Workerでinstallation revisionをCAS rollbackする。            | `--installation`、`--target-version`、`--expected-revision`、`--idempotency-key` | JSON: `installationId`、version差分、`revision`、`auditId`、`completedAt`                | `0` success、`1` client/request failure、`2` usage                           | mutationは自動retryしない。app、tenant、actorはBearer identityから決まり、URLとtokenの両設定が必要。[Rollback troubleshooting](../operations/rollback-troubleshooting.md)を参照。         |

## Copy-paste examples

dry-run deployはartifact hashとmanifest summaryを返し、Control Planeへ登録しません。以下のpathは
plugin project内のfile名に置き換えてください。

```sh
# cwd: repository root
# expected-exit: 0
ext deploy --app app_demo --plugin invoice-policy --version 1.0.0 --entry ./src/plugin.ts --manifest ./tenantscript.manifest.json --dry-run true
```

`ext rollback`と`ext approvals`の公開binaryはshipped Admin Workerのexact endpoint/bodyへ接続する。
`TENANTSCRIPT_CONTROL_PLANE_TOKEN`はAuthorization header以外へ出力せず、non-2xx responseではHTTP
statusと検証済みの公開error codeだけを表示する。raw response message、token、URLは表示しない。
既存の`createHttpRollbackClient` exportはpre-Admin APIのlibrary injection互換用であり、公開binary
からは使用しない。新規integrationは`createHttpAdminMutationClient`を使用する。

schema diffはbreaking changeをJSONでstdoutへ出し、exit `1`にします。互換なcandidateの例は次です。

```sh
# cwd: repository root
# expected-exit: 0
ext schema diff --from ./schemas/current.json --to ./schemas/candidate.json
```

## Automation guidance

1. stdoutはcommandごとのdocumented JSON shapeとしてparseし、stderr textを機械判定しません。
2. exit `2`は引数や入力を修正して再実行します。exit `1`はJSON resultまたはredacted diagnosticを
   調べ、同じmutationをblind retryしません。
3. `approvals`と`rollback`はaudit IDを使い回さず、同じ意図の応答喪失時だけ正本runbookの
   idempotency契約に従います。
4. 実装・tests・この表がずれた場合は、同じPull Requestでsource contractとreferenceを更新します。
