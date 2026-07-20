# npm package release contract

TenantScriptの公開packageは、registryへ書き込む前にclean checkoutからbuild、pack、install、importを
再現できなければなりません。`pnpm pack:check`がaccountlessな正本gateです。

## 対象

private workspaceを除く次の8 packageをdependency順にbuildします。

- `@tenantscript/capabilities`
- `@tenantscript/cli`
- `@tenantscript/control-plane`（`.`と`./rbac`）
- `@tenantscript/host-sdk`
- `@tenantscript/loader`
- `@tenantscript/manifest`
- `@tenantscript/plugin-sdk`
- `@tenantscript/proxy`

各packageの`tsconfig.build.json`は`src/**/*.ts`だけを`dist/`へemitします。rootのTypeScript
`paths`をbuildでは無効化し、topological orderを直列化することで、依存packageの宣言済み
`dist`を参照します。test、coverage、fixture、別workspaceのsourceを複製しません。

## Tarball allowlist

tarballに許可するのは次だけです。

- `package.json`
- package固有の`README.md`
- root Apache-2.0本文と一致する`LICENSE`
- `dist/**/*.js`、`dist/**/*.d.ts`

`src/`、`test/`、`coverage/`、`.env`、npm設定、private key、certificate、database fileは拒否します。
公開しないsourceを指す不完全なsource/declaration mapも生成・同梱しません。
全`exports`と`bin` targetの存在も検証します。1 packageあたり200 files、512 KiB packed、1 MiB
unpackedを上限とし、超過時は意図しない同梱としてfailします。

各packageのLICENSEはroot Apache-2.0本文とbyte-for-byteで一致することを常設testで守ります。
archive、temporary install、build outputはcheck終了時にcleanupされます。

## Clean install smoke

`pnpm pack:check`は全tarballをworkspace外のtemporary projectへ同時installします。npm lifecycleは
無効化し、呼び出し元のnpm/pnpm設定、registry credential、workspace pathを子processへ渡しません。
temporary HOMEを使った後、以下を確認します。

1. 全packageと公開subpathをESM importできる
2. `skipLibCheck: false`のtemporary TypeScript consumerで全公開declarationを解決できる
3. installed `ext` binaryが起動し、引数なしではtested usage exit `2`を返す
4. tarball内の`workspace:*`依存が利用者向けversionへ変換されている

成功時はpackageごとのfile count、packed/unpacked bytes、`smokeVerified: true`、
`typesVerified: true`をJSONで出します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm pack:check
```

Tier 1も同じintegration testを実行します。release workflowは独自buildを作らず、この入口を再利用
してください。

## Repository verificationと実publishの境界

このgateはnpmへpublishしません。`@tenantscript` scope確保、owner/2FA、npm trusted publishing、
GitHub environment approval、実provenanceのregistry確認は[Issue #3](https://github.com/albert-einshutoin/TenantScript/issues/3)
とrelease engineering [Issue #33](https://github.com/albert-einshutoin/TenantScript/issues/33)の外部laneです。
scope未確保中にtoken publishへfallbackしてはいけません。

version変更、changeset、SBOM、GitHub Release automationは後続taskです。tarball gateがgreenでも、
公開v1.0のrelease-readyを単独では証明しません。
