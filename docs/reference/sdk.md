# SDK Reference

Phase 1時点のpublic TypeScript surfaceの骨子。versionはまだ`0.0.0`であり、v1.0 API freezeまでは破壊的変更があり得る。package export以外の`src/*`へ直接importしない。

## `@tenantscript/manifest`

| API                                   | Purpose                                                     | Failure contract                      |
| ------------------------------------- | ----------------------------------------------------------- | ------------------------------------- |
| `TenantScriptManifest`                | plugin name/version/hooks/capabilities/config/egress/limits | TypeScript compile-time contract      |
| `parseManifest(input)`                | untrusted JSONをstrict validation                           | `{ok:false, errors:[{path,message}]}` |
| `validateConfig(schema, config)`      | required/type/unknown key検証                               | config値をerrorへ含めない             |
| `resolveGrants(capabilities, config)` | `$config.<key>`をinstallation scopeへ解決                   | 未定義referenceを拒否                 |

Manifest invariants:

- nameはlowercase kebab-case、versionはsemver-like。
- hook typeは`event | transform | policy`。
- egressは`deny`または明示host allowlist。
- provider secret、token、customer payloadをmanifestへ保存しない。

## `@tenantscript/host-sdk`

| API                               | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `defineHooks(definitions)`        | typed payload schemaと標準failure policyを固定                         |
| `runHook(hook, payload, execute)` | schema validation後だけhandlerを実行                                   |
| `planExecution(...)`              | enabled installationをeventはparallel、blocking hookはpriority順に計画 |
| `runTransformChain(...)`          | transform resultを次pluginへ直列伝播                                   |
| `retryPolicyForHookType(type)`    | eventのみ最大2 attempt、blocking hookは自動retryなし                   |
| `runWithRetryPolicy(...)`         | hook type別retry/failure policyを適用                                  |

Hostはtenant identity、hook payload schema、execution budgetを所有する。request bodyからtenantを自己申告させない。

## `@tenantscript/plugin-sdk`

| API                                    | Purpose                                                 |
| -------------------------------------- | ------------------------------------------------------- |
| `definePlugin({manifest, handlers})`   | manifest-declared handlerだけをdispatch可能にする       |
| `TenantScriptPlugin.dispatch(request)` | `{ok:true,value}`またはstructured `PluginDispatchError` |
| `PluginContext.capability(name,input)` | raw bindingsの代わりにscoped brokerを呼ぶ               |

Return contract:

- event handlerのreturn valueは破棄。
- transformはpayloadを必ず返す。
- policyは`allow`、`deny`、またはpayload付き`modify`を返す。
- undeclared/missing handlerとthrowはstructured errorになり、secretをmessageへ含めてはならない。

## `@tenantscript/capabilities`

`createCapabilityBroker`はgrant scope、provider、journal、rate limiter、audit sinkを結合する。pluginには`createPluginCapabilityContext`の結果だけを渡す。

Phase 1 built-ins:

- `slack.send`: channel scopeを強制。
- `approvals.request`: roleとresumeHook scopeを強制。
- `invoice.read`: tenantとfield scopeを強制。

同じexecution/call indexのretryはjournal resultを再利用する。capabilityまたはinputが変わったjournal entryは`CapabilityJournalConflictError`で拒否する。

providerを実行した呼び出しは`success`、grant/scope/rate limit等による拒否は`denied`、予期しないprovider障害は`error`として監査する。監査recordはcapability名、安定したreason、時刻だけを持ち、input、result、credential、provider error本文を保存しない。予期しないprovider障害は`CapabilityProviderError`へ正規化され、内部messageをpluginへ反射しない。journal replayは既存resultと監査を再利用するため、重複するprovider実行や監査recordを生成しない。

capability追加時は`packages/capabilities/test/capability-contracts.test.ts`へfixtureを追加し、grant、scope、監査、rate limit、冪等性、secret非露出、安定したエラー形状を共通検証する。

## `@tenantscript/proxy`

| API                                    | Purpose                                                    |
| -------------------------------------- | ---------------------------------------------------------- |
| `createInMemoryProxyMappingStore(...)` | local/test mapping contract                                |
| `handleWebhookProxy(...)`              | pathからtenant mappingを解決し、transform chain後にforward |

destinationはpublic HTTP(S)かつorigin allowlist内に限定する。transform失敗時は元payloadをforwardして`skipped: true`を返すため、host側でfailure policyと監視を決める。

## `@tenantscript/control-plane`

Control Planeはapp/tenant/plugin/version/installation、approval、rollback、audit、usageを管理する。Admin HTTPではapp/tenant/actor/roleを認証identityから導出する。

重要な運用契約:

- install/rollbackは`Idempotency-Key`を成功または明示cancelまで再利用。
- mutationはrevision CASとappend-only auditを維持。
- usage sinkはfail-openだが固定failure recordを内部logへ残す。
- storage/provider error本文はHTTPへ反射しない。

## Compatibility and verification

public surfaceを変更するPRは次を更新する。

```sh
# cwd: repository root
# expected-exit: 0
pnpm typecheck
pnpm test:security
```

Manifest/hook schemaを変更する場合は`ext schema diff`でbreaking changeを確認し、quickstartとreferenceのsnippetも同じPRで更新する。CIのexit code、warning、入力失敗の扱いは[Schema diff in CI](schema-diff-ci.md)を参照する。
