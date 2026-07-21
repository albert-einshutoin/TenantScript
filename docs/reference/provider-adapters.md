# Provider adapter contract

TenantScriptへ外部SaaS providerを追加するためのsecurity contractです。provider adapterはpluginと
external APIの間にあるtrusted boundaryであり、raw credential、任意のdestination、provider errorを
pluginへ公開してはいけません。

## 必須境界

新しいproviderは次をすべて満たします。

1. capability名とinputをclosed shapeで定義し、未知field、credential、header、tenant overrideを
   provider実行前に拒否する。
2. grantは操作対象をexact allowlistで表現する。prefix、substring、暗黙wildcard、空grantを許可しない。
3. credentialはtrusted token sourceからcall時に解決し、transport callbackへだけ渡す。plugin input、
   result、error、audit、journalへ含めない。
4. providerの公式なinvalid/expired credential応答だけを`ProviderCredentialRejectedError`へ変換する。
   timeout、429、permission、5xx、未知errorをcredential rejectionとして再送しない。
5. transport resultを公開に必要なclosed metadataへ縮小・検証してからbrokerへ返す。
6. [`capability-contracts.test.ts`](../../packages/capabilities/test/capability-contracts.test.ts)
   の共通kitでgrant、scope、audit、journal、rate limit、failure sanitizationを検証し、provider固有の
   越境・input・result testをsecurity suiteへ追加する。

## GitHub issue provider

`createGitHubIssueCreateProvider`は第2providerの正本実装です。

- capability: `github.issue.create`
- input: `{ repository, title, body? }`
- grant: `repositories`のexact `owner/repository` allowlist
- result: `{ number, url }`だけ。URLは同じrepositoryとissue番号のpublic GitHub URLに一致する必要がある
- credential: `createRotatingTokenCapabilityProvider`のactive/candidate snapshotから注入

`tenantscript/core`のgrantは`tenantscript/core-private`を許可しません。pluginは`authorization`等の
追加fieldを渡せず、transportがtokenや余分なresponse dataを返した場合もfail closedになります。

## Slack OAuth exchange

`createSlackOAuthClient`はSlackの一時authorization codeをbot access tokenへ交換するtrusted transport
です。固定origin、HTTP Basic client認証、exact HTTPS redirect allowlist、one-shot non-retry、64 KiB
response上限を持ちます。providerの完全な成功responseを検証した後、tokenとworkspace metadataだけを
既存`connectSlackWorkspace`境界へ渡します。refresh tokenやprovider errorは公開結果に含めません。

これはprovider capabilityそのものでも公開HTTP callbackでもありません。
`createSlackOAuthCallbackService`は先に`createDurableObjectNamespaceOAuthStateStore`で
browser/app/tenant/actor/redirectへ束縛したstateを一回だけconsumeし、復元scopeだけを既存接続境界へ渡します。
state storeは[OAuth state store](../operations/oauth-state-store.md)、合成順序は
[Slack OAuth callback composition](../operations/slack-oauth-callback.md)、交換と未実装HTTP境界は
[Slack OAuth v2 exchange boundary](../operations/slack-oauth-exchange.md)を参照してください。

## 検証境界

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/capabilities exec vitest run test/github-provider.test.ts test/capability-contracts.test.ts
pnpm --filter @tenantscript/capabilities test:security
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-client.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run test/oauth-state-store.test.ts
pnpm --filter @tenantscript/control-plane exec vitest run test/slack-oauth-callback.test.ts
```

これはaccountlessなadapter contractです。GitHub OAuth callback、GitHub App installation token発行、
production HTTP transport、live APIのrate limit/credential classificationは検証しません。deploymentは
公式API responseを用いたTier 2 testを追加し、token永続化とrotation手順は
[Provider token rotation](../operations/provider-token-rotation.md)に従ってください。
