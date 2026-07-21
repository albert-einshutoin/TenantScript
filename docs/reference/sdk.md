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
- hook typeは`event | transform | policy`。各hookはhost payload schemaへのsemver `schemaVersionRange`を必ず宣言する。
- egressは`deny`または明示host allowlist。
- provider secret、token、customer payloadをmanifestへ保存しない。

## `@tenantscript/host-sdk`

| API                               | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `defineHooks(definitions)`        | typed payload schemaと標準failure policyを固定                         |
| `runHook(hook, payload, execute)` | schema validation後だけhandlerを実行                                   |
| `planExecution(...)`              | enabled installationをeventはparallel、blocking hookはpriority順に計画 |
| `routeHookPayloads(...)`          | installationの互換rangeごとに最高schema versionのpayloadを生成・検証   |
| `runTransformChain(...)`          | transform resultを次pluginへ直列伝播                                   |
| `retryPolicyForHookType(type)`    | eventのみ最大2 attempt、blocking hookは自動retryなし                   |
| `runWithRetryPolicy(...)`         | hook type別retry/failure policyを適用                                  |

Hostはtenant identity、hook payload schema、execution budgetを所有する。request bodyからtenantを自己申告させない。

Dual-publish中はhostが`VersionedHookSchema[]`として公開version、Zod schema、canonical payloadからのprojection adapterを保持する。`routeHookPayloads`はenabled installationの`hookSchemaRanges`と交差する最高の安定versionを選び、adapter出力を選択後schemaで検証する。互換versionなし、不正range、重複version、adapter失敗は`HookSchemaCompatibilityError`でfail closedする。adapter由来のerrorやpayload値はerror messageへ反射しない。

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

## `@tenantscript/loader`

`runScopedHandler`はlocal development/replay向けにbundleをterminable Worker内の`node:vm`で実行する。productionのuntrusted multi-tenant実行はCloudflare Dynamic Workers境界を使い、このlocal isolateをproduction保証として扱わない。

`ScopedRuntimeLimits`の既定値と入力契約:

| Field            | Default    | Contract                                                                                |
| ---------------- | ---------- | --------------------------------------------------------------------------------------- |
| `timeoutMs`      | `250`      | 1以上のsafe integer。bundle評価、handler、async完了をwall-clockで打ち切る               |
| `maxSubrequests` | `Infinity` | 0以上のsafe integer、または内部既定値の`Infinity`。`0`はcapability callを許可しない     |
| `memoryMb`       | `128`      | 8以上のsafe integer。WorkerのV8 old-generation heap上限としてallocation stormを隔離する |

timeoutは`ScopedRuntimeTimeoutError`（`executionStatus: "timeout"`）、subrequestまたはheap上限超過は`ScopedRuntimeLimitError`（`executionStatus: "budget_exceeded"`）になる。`memoryMb`はV8 heap境界であり、OS、Cloudflare isolate、external/native allocationのproduction memory保証ではない。

`@tenantscript/loader/cloudflare`の`createCloudflareDynamicWorkerCaller`は、信頼されたhost Workerから
Cloudflare Dynamic Worker Loaderを呼ぶproduction composition境界である。

- worker IDはtenant、installation、plugin、artifact SHA-256、grant revisionの全scopeからopaqueに導出し、同じauthorityだけを再利用する。
- artifactは4 MiB以内かつ宣言SHA-256との完全一致を確認し、`ext deploy`が生成するCommonJS bundleのscaffold標準`plugin.dispatch`を固定ES module fetch wrapperから呼び出す。top-level `handlers`は既存bundle向けfallbackである。
- `globalOutbound: null`と信頼済みscoped bindingだけを渡し、呼び出しごとにCPU/subrequest limitとwall-clock timeoutを適用する。timeout時はrequestをabortし、`timeout` executionを永続化する。
- request/responseはclosed shapeかつ1 MiB以内とし、tenant codeの返値からusageやcapability evidenceを採用しない。
- runtime失敗は固定errorへ正規化してexecutionを1回だけ永続化する。永続化失敗もretryせず、provider error本文を反射しない。
- `readInvocationEvidence`失敗時はcapability callsとusageを0へfail-safeし、固定診断をreportする。
- cached `CAPABILITIES` bindingのRPCは`call(executionId, name, input)`で、server-owned execution IDを毎回渡す。bindingはこのIDをjournal帰属に使い、capability inputからexecution identityを受け取らない。

同期callerは正確なCPU時間を取得できないため`cpuMs: 0`を記録する。wall timeをCPU時間へ代用せず、
Workers Trace Events Logpushの`CPUTimeMs`をexecution IDへ非同期照合する責務は別の運用境界である。

## `@tenantscript/capabilities`

`createCapabilityBroker`はgrant scope、provider、journal、rate limiter、audit sinkを結合する。pluginには`createPluginCapabilityContext`の結果だけを渡す。

Phase 1 built-ins:

- `slack.send`: channel scopeを強制。
- `approvals.request`: roleとresumeHook scopeを強制。
- `invoice.read`: tenantとfield scopeを強制。

Phase 2 built-ins:

- `email.send`: 完全一致のASCII recipient domainとtemplate scopeを強制。pluginは自由なsubject/bodyを渡せず、broker側templateのnamed string変数だけを単一passで展開する。provider credentialはtrusted adapter内で注入し、plugin context、result、error、auditへ含めない。
- `http.fetch`: public HTTP(S) origin、標準method（GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS）、request header scopeを強制。redirectはtransportの自動追跡を無効化し、各hopのoriginと派生methodを再検証する。credentialはoriginごとのtrusted設定から注入し、別originへ持ち越さない。`createWebFetchHttpTransport`はWorkers標準`fetch`を`redirect: manual`、`credentials: omit`でadapter化する。
- `kv.state`: `get`、`put`、`delete`とkey prefixをgrantで制限し、JSON-compatible valueだけを保存する。`createKvStateProvider`へ渡すtrusted scope (`tenantId`、`pluginName`、`version`) はplugin inputから指定・上書きできない。各scopeを独立したDurable Object facetとして保存し、key/value/facet全体のUTF-8 byte数とentry数をtransaction内で検証する。`KvStateStorage`はDurable Object互換の`get`、`put`、`transaction`契約で、`createInMemoryKvStateStorage`はlocal/test用に同じ原子性を直列化して再現する。

Phase 3 built-ins:

- `github.issue.create`: `repositories`のexact allowlistとclosedな`repository`、`title`、`body` inputを強制する。`createGitHubIssueCreateProvider`はrotation-aware token sourceを再利用し、credentialをtransportだけへ注入する。resultは同じrepositoryの`number`とpublic issue `url`だけに限定する。adapter追加時の全契約は[Provider adapter contract](provider-adapters.md)を参照する。

同じexecution/call indexのretryはjournal resultを再利用する。capabilityまたはinputが変わったjournal entryは`CapabilityJournalConflictError`で拒否する。

providerを実行した呼び出しは`success`、grant/scope/rate limit等による拒否は`denied`、予期しないprovider障害は`error`として監査する。監査recordはcapability名、安定したreason、時刻だけを持ち、input、result、credential、provider error本文を保存しない。予期しないprovider障害は`CapabilityProviderError`へ正規化され、内部messageをpluginへ反射しない。journal replayは既存resultと監査を再利用するため、重複するprovider実行や監査recordを生成しない。

capability追加時は`packages/capabilities/test/capability-contracts.test.ts`へfixtureを追加し、grant、scope、監査、rate limit、冪等性、secret非露出、安定したエラー形状を共通検証する。外部SaaS adapterは[Provider adapter contract](provider-adapters.md)も満たす。

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
