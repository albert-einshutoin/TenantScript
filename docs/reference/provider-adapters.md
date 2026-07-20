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

## 検証境界

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/capabilities exec vitest run test/github-provider.test.ts test/capability-contracts.test.ts
pnpm --filter @tenantscript/capabilities test:security
```

これはaccountlessなadapter contractです。GitHub OAuth callback、GitHub App installation token発行、
production HTTP transport、live APIのrate limit/credential classificationは検証しません。deploymentは
公式API responseを用いたTier 2 testを追加し、token永続化とrotation手順は
[Provider token rotation](../operations/provider-token-rotation.md)に従ってください。
