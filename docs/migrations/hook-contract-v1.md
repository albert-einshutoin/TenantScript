# Hook contract v1 migration

対象: `@tenantscript/manifest`、`@tenantscript/host-sdk`、`@tenantscript/plugin-sdk`、
`@tenantscript/loader`、`@tenantscript/proxy`。

## Before / after

- `fail-open`、`skip`、`deny`はそれぞれ`record-only`、`fail-closed`へ置き換える。eventはrecord-only、transformとpolicyはfail-closed。
- event handlerは`undefined`ではなく`{ status: "accepted" }`を返す。
- transform handlerはpayloadそのものではなく`{ status: "transformed", output: payload }`を返す。
- policy handlerは`modify`や自由形式の`reason`ではなく`{ decision, reasonCode }`を返す。
- `UnknownHookError`などのname/message依存をやめ、閉じた`code`を記録・表示する。
- Proxyはtransform failure時に元payloadを転送せず、`plugin_result_invalid`で停止する。`webhook.outbound`以外のhook typeは拒否する。

## 手順

1. manifestの各hookへ上表の`failurePolicy`を明示し、`webhook.outbound`をtransform/fail-closedにする。
2. plugin handlerのreturn shapeとpolicy reason codeを更新する。
3. `runTransformChain`のcallbackでcanonical resultを返し、failure resultはcallerのfail-closed経路へ渡す。
4. `PluginDispatchError`とloader/proxy errorは`code`だけを境界越しに扱い、raw messageをログやHTTPへコピーしない。
5. `pnpm typecheck`、対象package test、`pnpm test:security`を実行する。

このalpha releaseでは旧shape（undefined、payload直返し、modify）の互換aliasは提供しない。既存の
top-level `handlers` exportはdeprecatedなbundle入口として一時的に受け付けるが、canonical
result shape以外は拒否し、v1 API freezeで削除する。必要なら変更前のartifact/versionへrollbackする。
