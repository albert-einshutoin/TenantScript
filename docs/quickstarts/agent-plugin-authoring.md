# Agent-friendly plugin authoring

coding agentまたは初見のplugin authorが、TenantScriptのprivate APIを推測せず、manifestを含む最小pluginをTDDで作るための一本道です。scaffoldは安全な出発点であり、live Cloudflare deployや外部capability grantの証跡ではありません。

## Verification status

- **Repository verified** — Tier 1は`ext init`の生成物を、実際にpackした`@tenantscript/manifest`と`@tenantscript/plugin-sdk`へ接続し、fresh directoryでinstall、build、生成testまで実行します。
- **Blocked** — npm packageはscope確保とtrusted publishing activationまで未公開です。公開前のcheckoutではrepository commandを使い、存在しないregistry versionを回避しないでください。
- **Not live verified** — scaffold testはCloudflare credential、account、paid planを使わず、実deploy成功を主張しません。

## Agentへ渡す契約

次の要件をpromptまたは作業指示に含めます。

1. handlerより先にmanifestと失敗するtestを変更する。
2. hook名と型をhost contractへ一致させ、`schemaVersionRange`はhost payload schemaの範囲にする。
3. `capabilities`は実際に呼ぶ最小scopeだけを宣言し、provider tokenやsecretをmanifest、source、test fixtureへ書かない。
4. outbound accessが不要なら`egress: { mode: "deny" }`を維持する。
5. declared hook成功、undeclared hook拒否、未宣言capabilityを呼ばないことをtestする。
6. build/test後、dry-run artifactとmanifest差分を人間がreviewするまでlive deployしない。

## 1. Scaffoldを生成する

公開後はCLIと生成SDK依存が同じexact versionになります。`<version>`をレビュー済みのreleaseへ置き換え、floating tagを使わないでください。
レビュー済みのhook/typeと最小権限境界から始める場合は、組み込みtemplateを使用します。templateは
networkからcodeを取得せず、`SECURITY.md`、behavior test、capabilityなし・egress denyのmanifestを
生成します。`webhook-transformer`はpayload passthrough、`invoice-approval`はinteger centsの
入力検証とfail-closedな金額境界、`api-policy`はread-only methodとpath-segment境界を持つroute
allowlistを例示します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm dlx @tenantscript/cli@<version> init --template webhook-transformer --dir ./webhook-transformer
cd webhook-transformer
pnpm install --frozen-lockfile=false
pnpm build
pnpm test
```

policy hookの例を生成する場合はtemplate名とdirectoryを置き換えます。100,000 centsのthresholdは
production ruleではないため、trusted actor/config契約を設計し、先に境界testを変更してから採用して
ください。

```sh
# cwd: repository root
# expected-exit: 0
pnpm dlx @tenantscript/cli@<version> init --template invoice-approval --dir ./invoice-approval
```

API policyの例はhostがcallerを認証し、URLをdecode・normalizeした後のpathnameを渡す契約です。
raw URL、query、fragment、tenant identityをtemplateが安全に解決すると仮定しないでください。
`/v1/reports`は例示routeなので、productionで使う前にhost schema、RBAC、route契約へ置き換え、
prefix confusion、mutation、ambiguous pathのdeny testを維持します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm dlx @tenantscript/cli@<version> init --template api-policy --dir ./api-policy
```

独自hookのgeneric scaffoldが必要な場合は、name、hook、typeを明示します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm dlx @tenantscript/cli@<version> init --name large-invoice-notify --dir ./large-invoice-notify --hook invoice.created --type event
cd large-invoice-notify
pnpm install --frozen-lockfile=false
pnpm build
pnpm test
```

repository checkoutでnpm公開前の契約を再現する場合は、rootから次を実行します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:agent-scaffold
```

このgateは生成されたTenantScript依存がCLI package versionと完全一致することも検証します。CLI package metadataが不正な場合、`ext init`はpartial directoryを作る前にfail closedになります。

## 2. RED: 期待する振る舞いを先に書く

生成された`test/plugin.test.ts`は、次のsecurity baselineを既に持ちます。

- manifestで宣言したhookだけがdispatch成功する
- undeclared hookは`UnknownHookError`になる
- 空の`capabilities`でcapability brokerを呼ばない

要件を追加するときは、先にtestを失敗させます。Slack通知を追加する例なら「閾値未満では呼ばない」「閾値以上で`slack.send`を1回だけ呼ぶ」「tokenをinput/resultへ含めない」を先に固定します。

## 3. GREEN: manifestを最小権限で変更する

`src/manifest.ts`を先に更新します。channelをinstallation configへ束縛し、raw tokenを受け取らない例です。

```ts
capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
configSchema: {
  properties: { notifyChannel: { type: "string" } },
  required: ["notifyChannel"]
},
egress: { mode: "deny" }
```

次に`src/index.ts`のhandlerへ最小実装を加え、`pnpm build`と`pnpm test`を再実行します。公開package rootだけをimportし、`dist/`や別workspaceの`src/`へdeep importしないでください。

## 4. Deploy前review

- manifestのname/version/hookがentry pointと一致する
- capability/configが最小で、secret値がない
- egress allowlistが必要な場合、schemeやwildcardではなく必要hostだけである
- timeout/CPU limitを広げる理由がreview可能である
- testsが成功経路だけでなくundeclared hookとcapability非呼び出しを守る

Control Planeへ登録する前に、[SDK integration quickstart](sdk-integration.md)のhost integrationとdeploy dry-runを完了してください。schema契約は[Manifest JSON Schema](../reference/manifest-json-schema.md)、公開APIは[SDK reference](../reference/sdk.md)を正本にします。
