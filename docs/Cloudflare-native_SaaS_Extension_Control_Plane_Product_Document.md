# TenantScript Product Thesis and Versioned MVP Plan

**Product Strategy & Normative PRD**<br>
**カテゴリ:** Tenant Extension Control Plane for B2B SaaS<br>
**プロダクト名:** TenantScript<br>
**作成日:** 2026-06-11<br>
**更新日:** 2026-08-25 — Issue [#361](https://github.com/albert-einshutoin/TenantScript/issues/361) の製品境界、true MVP、ICP、version別success metricsを反映<br>
**ステータス:** Normative product PRD — roadmapと実装Issueはこの文書および[#360](https://github.com/albert-einshutoin/TenantScript/issues/360)に従う

---

## 最終方針

Cloudflareはネットワークと実行primitiveを提供する。TenantScriptはその上に、B2B SaaSの顧客別extensionのライフサイクルとガバナンスを提供する。

TenantScriptは、tenant / host app / installationのidentity、hookとmanifest、version・enable/disable・rollback、capability grant、provider-secret境界、approvalとfailure policy、execution evidence、audit、usage、operator workflowを所有する。

TenantScriptはCDN、Cloudflareの代替、汎用workflow builder、汎用runtimeではない。MVPでは、顧客別Webhook変換を安全に運用する一つの狭いjourneyに集中する。

---

## 1. Executive Summary

Cloudflare Dynamic Workers / Workers for Platforms / D1 / R2 / Durable Objects / Workflows は、untrusted codeを隔離して実行するための強いプリミティブを提供している。一方で、SaaS開発者がそのまま導入できるプロダクトレイヤー、つまりmanifest、permission UI、tenant secret管理、hook SDK、versioning、rollback、execution logs、billing meter、local dev、approval UIは薄い。

勝ち筋は「Cloudflareより良いRuntime」ではない。勝ち筋は、Cloudflare上で顧客別拡張を安全に運用するためのControl Plane、SDK、管理UI、運用規約、監査機能をまとめること。

| 評価軸 | 結論 |
|---|---|
| 市場性 | エンタープライズ顧客ごとの例外実装・自動化・連携要望は強い。Solutions Engineering工数削減に直結する。 |
| 技術タイミング | Cloudflareが必要なkernelを揃えつつある。上位レイヤーはまだプロダクト化余地がある。 |
| 最大リスク | メンテナの持続可能性(bus factor)。Cloudflare公式の上位レイヤー進出は非商用OSSには致命傷でなく、manifest / capability modelが標準として残れば成果と見なす。 |
| 初期勝ち筋 | SaaSのcoreへtenant別分岐を追加せず、Solutions EngineerやPlatform Engineerが顧客別Webhook変換を出荷できること。 |
| やらないこと | CDN、汎用workflow builder、marketplace、AI authoring、WASM、multi-cloud、hosted commercial serviceをMVPの価値にしない。 |

## Problem statement

B2B SaaSが顧客ごとの小さなbackend差分を提供しようとすると、次のいずれかを選びやすい。

- Webhookを顧客固有のschemaへ変換する
- 閾値を超えた操作に追加承認を要求する
- イベントを会社固有のdestinationへrouteする
- tenantごとのpolicyでAPI actionをdenyする
- Slack、Jira、GitHubなどの顧客固有workflowへ通知する

この種の要望に対して、実装の選択肢は次のいずれかになりやすい。

- SaaS coreへtenant-specificなif分岐、feature flag、権限例外を追加する
- 顧客専用forkまたはone-off deployを維持する
- Lambda / Workerなどの個別関数を運用し、tenant・secret・rollbackの境界を別々に持つ
- embedded iPaaSや汎用workflow builderへ寄せ、SaaS domainのinstallation・permission・evidenceを自前で補う

これらは顧客別要件を満たしても、coreの変更負債、運用経路の分散、tenant越境・secret露出・rollback不能のリスクを増やす。TenantScriptは、顧客別extensionをSaaS coreから分離しながら、SaaS運営者が必要とするidentity、権限、version、evidence、rollbackを一つのcontrol planeに集約する。

---

## 2. Product Thesis / Positioning

TenantScriptはCloudflareのruntimeを再実装するのではなく、SaaS domainのextension control planeとして位置づける。

| 項目 | 推奨方針 |
|---|---|
| カテゴリ | Tenant Extension Control Plane for B2B SaaS |
| 一言説明 | 顧客別のWebhook変換・policy・通知・approvalを、SaaS coreへのtenant別分岐なしに、安全に運用するOSS control plane。 |
| 英語コピー | Ship customer-specific Webhook logic without adding tenant-specific branches to the SaaS core. |
| 日本語コピー | SaaS本体に顧客別分岐を増やさず、顧客別Webhookロジックを安全に出荷する。 |
| Cloudflareとの関係 | Cloudflareはnetworkとexecution primitiveを提供し、TenantScriptはSaaS-domainのlifecycleとgovernanceを提供する。 |
| 類比 | B2B SaaSに埋め込むextension control plane。CDN、汎用iPaaS、general-purpose runtimeの代替ではない。 |
| 事業形態 | pure OSS(D-008)。収益化を目的とせず、self-hostを唯一の運用形態とする。 |
| AI Coding時代の位置づけ | AI authoringは後続versionの入力手段であり、MVPの製品価値や安全性の証明とは分離する。 |

---

## 3. Decision Register

| ID | 決定 | 理由 / 影響 |
|---|---|---|
| D-001 | Tenant Extension Control Planeとして位置づける | Cloudflareのnetwork/runtimeを再実装せず、manifest、installation、permission、evidence、versioning、rollback、operator workflowを所有する。 |
| D-002 | 初期ユーザーはSaaS運営者・SE | 最初から顧客自身が自由にコードを書く前提にしない。Solutions Engineerが顧客別extensionを書く痛みから入る。 |
| D-003 | true MVPはtenant-specific Webhook transformationに絞る | notification、approval、API policy、AI agent toolは後続versionの候補として保持し、MVPへ混ぜない。 |
| D-004 | Capability-first SDK | Pluginにraw secretやDBを直接渡さない。ctx.slack.send / ctx.invoice.readのようなscoped capabilityだけを渡す。 |
| D-005 | Egress deny-by-default | untrusted codeの外部通信は原則禁止。必要な場合はallowlist、gateway injection、auditを通す。 |
| D-006 | Version pinning / rollbackをMVPに入れる | 顧客別extensionは事故時に即時停止・rollbackできる必要がある。運用品質の中核。 |
| D-007 | Marketplaceは後回し | 初期にmarketplaceを作ると鶏卵問題になる。まずはhost app内のprivate plugin distributionを完成させる。 |
| D-008 | Pure OSS戦略(収益化を目的としない) | 全コンポーネントをOSSで公開し、self-hostを唯一の運用形態とする。資金はGitHub Sponsors / Buy Me a Coffee / CloudflareのOSSスポンサー制度に留め、有償hosted版やopen-core分割は行わない。持続可能性はcoreを小さく保つことで担保する。 |
| D-009 | Cloudflare-nativeに集中 | MVPでnon-Cloudflare runtime互換を追わない。Cloudflare primitivesの速度と差別化を最大化する。 |
| D-010 | Cost guardrailsを1st-classにする | Dynamic Workerのstable ID、version hash、per-plugin budget、runaway detection、usage dashboardを設計に含める。 |
| D-011 | 承認はcontinuation hookモデルで実装する | Workers isolateは実行途中のdurable suspendができない。plugin handlerは常に短命に保ち(timeoutMs制限と整合)、承認のライフサイクル(通知、リマインド、期限切れ)はWorkflowsが管理する。決定時にresumeHookを新しいexecutionとして起動する。 |
| D-012 | hookに型(event / transform / policy)を導入する | 型ごとに実行モード(並列/直列)、戻り値契約、failure policyが決まる。一律fail-closedはevent系hookで本体をブロックするため採用しない。 |
| D-013 | per-installation configを1st-classにする | 通知チャンネルや金額閾値のテナント差分をコードフォークで吸収させない。manifestのconfigSchemaで宣言し、install時に設定し、ctx.configで参照する。 |
| D-014 | capability callをexecution journalで冪等化する | retry時の二重送信(Slack二重通知など)を防ぐ。journalはDurable Objectに記録し、replay時は完了済みcallをskipする。 |
| D-015 | Proxy modeを導入の入口にする | SDK統合(本体へのhook工事)は最大の採用障壁。v0.1ではoutbound webhook transformationに絞り、後続versionでnotification rulesを追加できる境界を保つ。 |
| D-016 | AI coding agentを前提に設計する | pluginの書き手は人間のSEだけでなくAIになる。typed SDK、manifest validation、capability sandbox、local replayはAI生成コードの安全装置として機能する。docs / llms.txt / scaffoldをagent-friendlyに整備し、配布チャネルとしても扱う。 |
| D-017 | 実装言語はTypeScriptに統一する | Workers runtime(V8 isolate)のネイティブ言語であり、Dynamic Worker Loader / D1 / R2 / DO / Workflowsのbindingsが第一級。plugin author(SE / AI agent)とhost SDK導入先の主要言語でもある。SDK / loader / control plane / CLI / UIを単一言語にしてOSS貢献障壁を下げる(D-008と整合)。Rust/WASMはv2.0のportability検討時に再評価。GoはWorkers第一級サポートがなくD-009と矛盾するため不採用。 |

---

## 4. Product Value

価値は「pluginを動かせる」ことではなく、SaaS企業がエンタープライズ顧客ごとの要望を安全に商品化できることにある。

| 対象 | Before | After / 提供価値 |
|---|---|---|
| SaaS経営・Product | 大口顧客ごとの例外要望が本体ロードマップを圧迫する。 | 顧客別ロジックをextensionとして分離し、個別対応を収益化・再利用・監査可能にする。 |
| Engineering | 一回限りの分岐、feature flag、tenant-specific codeが本体に蓄積する。 | hook SDKとversioned pluginで本体を汚さず実装。rollbackとlogsで運用事故を抑える。 |
| Solutions Engineering | 顧客ごとにカスタム実装をbackend deploy待ちで進める。 | 安全なsandboxとlocal devで、短いコードを顧客別に素早く出荷できる。 |
| Enterprise customer | 要望が本体ロードマップ待ちになる。 | 自社ルール、通知、承認、変換を短期間で導入。権限と監査ログも見える。 |
| Compliance / Security | 顧客別コードがどこで何をしているか見えにくい。 | manifest、permission、egress allowlist、execution log、version historyを一元管理する。 |

---

## 5. ICP / Personas / Jobs

### 初期ICP

Initial design partners must meet all of the following:

- B2B SaaS with enterprise or upper-mid-market customers
- 年5件以上の顧客別backend変更
- 顧客ごとにWebhook、policy、approval、routing、notificationの差分がある
- engineering、platform、またはSolutions Engineeringのownerがいる
- Cloudflare-backed self-host infrastructureを運用する意思がある
- 過去の実装リードタイムを計測できる

優先segmentは次の順序とする。

| 順位 | Segment | 初期メッセージ |
|---|---|---|
| 1 | Developer-facing SaaS | typed hooksで顧客別のextensionを安全に出荷する。 |
| 2 | FinOps / Billing / Procurement SaaS | 顧客別の請求・購買ロジックをcoreへハードコードしない。 |
| 3 | Vertical SaaS | 顧客固有の業務ルールを監査可能なextensionへ分離する。 |
| 4 | Security / Compliance SaaS | tenant別policyを明示的な権限とevidence付きで運用する。 |
| 5 | AI-agent SaaS | tenant-scoped business actionを安全に実行する。 |

### Personas

| Persona | 役割 | 痛み / 評価基準 |
|---|---|---|
| Champion | Solutions Engineer、Forward-Deployed Engineer、Platform Engineer、またはenterprise customizationを担当するbackend engineer | 顧客別実装をSaaS coreのdeployなしに出荷し、権限・test・audit・rollbackを保ちたい。 |
| Economic buyer | CTO、VP Engineering、Head of Product | 顧客別保守とroadmap interruptionを減らしたい。 |

### Jobs to be Done

> When an enterprise customer requests a small backend rule or integration difference, I need to deliver it for only that tenant, with explicit permissions, tests, audit, and rollback, without modifying or redeploying the SaaS core for every exception.

- 顧客別Webhook変換をSaaS coreのtenant-specific branchなしに出荷したい。
- 顧客固有のロジックが壊れたとき、そのtenantだけを停止して既知のversionへ戻したい。
- 顧客別codeの権限と実行結果をmanifest、grant、audit evidenceで説明したい。

---

## 6. Scope / Use Cases

| Version | Use Case | Scope |
|---|---|---|---|
| v0.1.0 | Tenant-specific Webhook transformation through Proxy Mode | 必須のtrue MVP。install、enable、execute、observe、version update、rollbackを含む。 |
| v0.2.0 | Live Cloudflare runtime and self-host path | v0.1のrepository journeyを実accountで検証する。 |
| v0.3.0 | Design-partner validation | 一つの狭いuse-case familyで3 pluginsを4週間検証する。 |
| v0.4.0 | Provider capability and approval | partner evidenceに基づき、private betaへ拡張する。 |
| v0.5.0 | Public beta and independent operation | package、self-host、security review、fork CIを独立検証する。 |
| v1.0.0+ | Stable OSS and ecosystem | API stability、adoption、community、AI、portabilityを証拠に基づき進める。 |

---

## 7. Core UX / SDK Surface

### Plugin author experience

```ts
export default definePlugin({
  // event hook: 非同期通知。本体処理はブロックしない。
  async onInvoiceCreated(event, ctx) {
    if (event.amount > ctx.config.thresholdAmount) {
      await ctx.slack.send(ctx.config.notifyChannel, "Large invoice created");
      // 承認要求を登録してこのhandlerは終了する。
      // durable suspendはしない(D-011)。承認のライフサイクルはWorkflowsが管理する。
      await ctx.approvals.request({
        role: "manager",
        subject: { type: "invoice", id: event.invoiceId },
        resumeHook: "onInvoiceApprovalDecided",
      });
    }
  },

  // continuation hook: 承認決定後に別executionとして呼ばれる
  async onInvoiceApprovalDecided(event, ctx) {
    if (event.decision === "approved") {
      await ctx.slack.send(ctx.config.notifyChannel, "Invoice approved");
    }
  },
});
```

テナント差分(チャンネル名、金額閾値)はコードに書かず、manifestのconfigSchemaで宣言してinstall時に設定し、ctx.configで参照する(D-013)。

### SaaS host app experience

```ts
// hook定義: 型(event / transform / policy)ごとに実行モードとfailure policyが決まる(D-012)
defineHooks({
  "invoice.created": {
    type: "event",              // 並列実行、non-blocking、record-only
    schema: invoiceCreatedSchemaV1,  // versioned payload schema
  },
  "webhook.outbound": {
    type: "transform",          // Installation.priority順の直列チェーン
    failurePolicy: "fail-closed", // 不正resultや失敗時は転送しない
    budgetMs: 500,
  },
  "api.request": {
    type: "policy",             // 直列。allow/denyとreasonCodeを返す
    failurePolicy: "fail-closed",
    budgetMs: 150,
  },
});

// 実行。capabilityはrun時に渡さず、installationのgrant(manifest照合済み)で決まる
await extensions.run("invoice.created", { tenantId, payload });
```

| Surface | 責務 | 代表API / 画面 |
|---|---|---|
| Host SDK | SaaS本体からhookを定義・実行する。hook型(event/transform/policy)、failure policy、versioned payload schemaを管理する。 | createExtensionRuntime(), defineHooks(), extensions.run() |
| Plugin SDK | Plugin authorがhook handler、ctx capability、ctx.config、continuation hookを使う。 | definePlugin(), ctx.config, ctx.slack.send(), ctx.approvals.request() |
| Admin UI | tenantごとのinstall、installation config編集、permission approval、version pinning、rollback、logsを見る。 | Install, Config, Permissions, Versions, Executions, Approvals |
| CLI / Local dev | pluginのbundle、type生成、local replay、manifest validation、schema互換チェックを行う。 | ext dev, ext build, ext replay, ext schema diff, ext deploy |
| Control Plane API | metadata、artifact、secrets、executions、usage meterを管理する。 | /plugins, /installations, /executions, /approvals |

---

## 8. Product Specification

### Domain Model

| Entity | 説明 | 主な属性 |
|---|---|---|
| App | Extension Control Planeを組み込むSaaSアプリ。 | appId, name, hooks, defaultPolicies |
| Hook | host appが公開する拡張点。型が実行モードと戻り値契約を決める。 | name, type(event/transform/policy), schemaVersion, failurePolicy, budgetMs |
| Tenant | SaaSの顧客単位。 | tenantId, plan, region, enabledFeatures |
| Plugin | 拡張機能の論理単位。 | pluginId, name, owner, status |
| Plugin Version | 実行されるbundle artifactのversion。 | version, codeHash, manifest, artifactUrl, createdAt |
| Installation | tenantにplugin versionを紐づける設定。configSchemaに対する実際の設定値を持つ。 | tenantId, pluginId, version, grantedCapabilities, config, priority, enabled |
| Capability | Pluginから呼び出せるscoped operation。 | name, scopes, rateLimit, auditPolicy |
| Secret Reference | raw secretをPluginに渡さずbrokerで保持する参照。 | tenantId, provider, secretRef, rotationStatus |
| Execution | hook実行ごとの記録。 | executionId, tenantId, hook, version, durationMs, status, logs |
| Approval | 人間の承認待ち状態。決定時にresumeHookを新しいexecutionとして起動する。 | approvalId, tenantId, role, subject, state, decidedBy, resumeHook, expiresAt |
| Usage Meter | 課金・COGS・制限に使う利用量。 | tenantId, pluginId, executions, cpuMs, subrequests, workflowRuns |

### Manifest example

```json
{
  "name": "large-invoice-approval",
  "version": "1.0.3",
  "hooks": [
    { "name": "invoice.created", "type": "event", "timeoutMs": 250, "schemaVersionRange": "^1.0.0" },
    { "name": "onInvoiceApprovalDecided", "type": "event", "timeoutMs": 250, "schemaVersionRange": "^1.0.0" }
  ],
  "configSchema": {
    "properties": {
      "thresholdAmount": { "type": "number", "default": 100000 },
      "notifyChannel": { "type": "string" }
    },
    "required": ["notifyChannel"]
  },
  "capabilities": {
    "slack.send": {
      "channel": "$config.notifyChannel"
    },
    "approvals.request": {
      "roles": ["manager"],
      "resumeHooks": ["onInvoiceApprovalDecided"]
    },
    "invoice.read": {
      "fields": ["id", "amount", "customerId", "status"]
    }
  },
  "egress": {
    "mode": "deny"
  },
  "limits": {
    "cpuMs": 20,
    "timeoutMs": 1000
  }
}
```

hooksはpluginが実装するhandler名、hook型、timeoutMsを宣言する。`onInvoiceApprovalDecided`は§7の承認決定後に別executionとして起動されるcontinuation hook(D-011)である。`approvals.request.resumeHooks`は承認後に再開できるhandlerを明示的に束縛し、manifest例をcopyしたpluginが任意のcontinuation hookへ広げないために宣言している。capability grantは`$config.*`参照でinstallation configに束縛でき、テナントごとに許可範囲を変えられる。handlerは人間の承認を待ってsuspendしないため、各hookのtimeoutMsは通常のevent handler向けの上限である。

### Hook schemaの進化

hook payload schemaはsemverで版管理する。pluginはmanifestで互換rangeを宣言し、CLIの`ext schema diff`がbreaking changeをCIで検出する。breaking changeを伴う変更では、hostは新旧schemaのdual-publish期間を設け、全installationの移行状況をAdmin UIで追跡してから旧versionを廃止する。host appのschema変更で全テナントのpluginが静かに壊れる事態を、プラットフォームの契約として防ぐ。

### Execution Lifecycle

1. SaaS本体がextensions.run(hookName, { tenantId, payload })を呼ぶ。
2. Control Planeがtenantにinstall済みのactive plugin versionsを解決する。同一hookに複数installationがある場合、event hookは並列(順序保証なし)、transform / policy hookはInstallation.priority順の直列チェーンとして実行計画を作る。
3. Plugin artifactをR2から取得し(version hashでcache)、stable worker ID + version hashでDynamic Worker / dispatch targetを解決する。
4. Manifestとinstallation grantを照合してscoped capability bindingsを生成し、installation configをctx.configとして束縛する。
5. Egress policy、CPU/subrequest/timeout、tenant budgetを設定して実行する。
6. capability callはexecutionごとのjournal(Durable Object)に記録する。retry時はjournal済みのcallをskipし、二重送信を防ぐ(D-014)。
7. transform hookは`{status: "transformed", output}`を前段から後段へ渡す。policy hookは`{decision, reasonCode}`を返し、denyの時点でチェーンを打ち切る。
8. 結果、ログ、duration、error、usageをExecutionとして保存する。
9. ctx.approvals.request()が呼ばれた場合、Workflowが承認のライフサイクル(通知、リマインド、エスカレーション、期限切れ)を管理し、決定時にresumeHookを新しいexecutionとして起動する。plugin実行自体はsuspendしない(D-011)。
10. 失敗時はhookのfailure policy(event: record-only / transform: fail-closedまたは明示的use-original / policy: fail-closed)に従い、retry、plugin disable、rollback候補を提示する。

---

## 9. Reference Architecture

```text
SaaS Host App
   |
   | extensions.run(hook, tenantId, payload)
   v
Host SDK / Gateway Worker
   |
   | resolves installation + version + grants
   v
Control Plane API  ---- D1: metadata / installation / execution
   |                  R2: bundled plugin artifacts
   |                  Durable Objects: plugin state / rate limits
   |                  Workflows: approvals / long-running steps
   v
Dynamic Worker / Workers for Platforms dispatch target
   |
   | scoped ctx capabilities only
   v
Capability Broker ---- Slack / Email / D1 / R2 / external APIs
   |
   v
Execution Logs / Usage Meter / Admin UI
```

| 機能 | 推奨Cloudflare primitive | 設計メモ |
|---|---|---|
| Runtime execution | Dynamic Workers / Workers for Platforms | untrusted tenant codeを隔離して実行。stable ID + version hashでcostとcacheを制御。 |
| Metadata | D1 | apps, tenants, plugins, versions, installations, grants, executionsを保存。 |
| Artifacts | R2 | bundled plugin code、source maps、manifest snapshotsをversioned objectとして保存。 |
| Per-plugin state | Durable Objects / Durable Object Facets | rate limits、tenant state、plugin-local durable stateを扱う。 |
| Long-running steps | Workflows | approval、retry、sleep、external event待ちを扱う。 |
| Logs | Tail Worker + D1/R2 | hot queryはD1(app単位にDB分割し、D1の10GB上限を考慮)、長期保存はR2。usage集計はWorkers Analytics Engineを第一候補にする。 |
| Secret broker | Worker bindings / broker service | raw secretはpluginに渡さず、capability call時にgateway側で使用。 |
| Egress control | Outbound Worker / allowlist policy | deny-by-default、allowlist、audit、credential injection。 |

### Blocking hookのレイテンシ予算

transform / policy hookはhost本体のrequest pathに入るため、SLOを設けてv0.2 Live Edge Alphaで実測検証する。

- 目標: plugin 1段あたりのadded latencyをp95でwarm < 50ms、cold < 300msに収める。
- 対策: stable worker ID + version hashによるisolate再利用、artifactのcolo cache、capability brokerのsame-colo配置、deploy時のpre-warm。
- hook単位の合計予算(budgetMs)を超えた場合はfailure policyに従って打ち切る。

---

## 10. Security / Permission Model

| 原則 | 仕様 |
|---|---|
| Raw secretを渡さない | Slack token、API key、DB credentialはPluginに渡さない。ctx.slack.send等のbrokered operationだけを公開する。 |
| Capabilityはscoped | invoice.readはtenant=current、fields=[...]、条件付きqueryなどに制限する。 |
| Egress deny-by-default | fetch()は原則禁止。必要な外部APIはallowlist + brokered fetch + auditを通す。 |
| Install-time permission UI | manifest要求権限と実際にgrantする権限をtenant admin / SaaS adminが確認する。 |
| Runtime limits | CPU、subrequests、timeout、memory相当、workflow runs、daily budgetをtenant/pluginごとに制限する。 |
| Audit-first | capability call、approval decision、egress attempt、version change、rollbackをExecution Logに残す。 |
| Capability callの冪等化 | executionごとのjournalに記録し、retry時は完了済みcallをskipする。通知の二重送信を防ぐ。 |
| Failure policyはhook型で決まる | policy hookはfail-closed、event hookはrecord-only、transform hookはfail-closedまたはhostが安全性を明示したuse-originalだけを許可する。manifest不一致、grant不足、secret missing、budget超過による「実行可否」の判断は常にfail-closed(実行しない)。 |

---

## 11. True MVP / v0.1.0 Repository MVP

最初に検証する製品価値は、**tenant-specific Webhook transformation through Proxy Mode**である。

```text
Host SaaS canonical event
  -> TenantScript Proxy
  -> host app + tenant + installationを解決
  -> pinned transform pluginを実行
  -> outputを検証
  -> installationが許可したdestinationへだけdelivery
  -> execution evidenceを記録
```

v0.1.0は外部credentialなしで、このextension lifecycleをrepository上で証明する。

### Required scope

- deterministic tenant resolution付きProxy Mode
- `webhook.outbound` transformという一つのhook type
- typed manifestとinput/output contract
- deny-by-default egressとinstallation-owned destination
- plugin artifact integrity
- installation version pinning、enable / disable / rollback
- timeout、payload、output、subrequestのbounded limits
- stable execution statusとnon-reflective errors
- operator debuggingに十分なexecution evidence
- local/accountless E2Eとlive Cloudflare evidenceを分離したgate

### Explicitly excluded from the true MVP

- customer-authored arbitrary code upload UI
- marketplaceとreuse counters
- Slack/GitHub OAuth
- human approval workflow
- broad capability ecosystem
- AI-assisted authoring
- WASM / Extism runtime
- multi-cloud runtime portability
- billingとcommercial hosted service
- visual workflow builder

### v0.1.0 exit criteria

- packed packagesがclean installできる
- example SaaSが一つのcanonical Webhook eventを発火できる
- 2 tenantが異なるpinned transformをdata crossoverなしに実行できる
- installationのenable / disable / version update / rollback E2Eがgreenになる
- malformed payload、undeclared egress、timeout、artifact mismatchがfail-closedになる
- repository evidenceをlive production proofとして表現しない

---

## 12. Version plan

後続versionへ進む条件は、前versionのrepository evidenceと外部evidenceを混同せず、checkpoint Issueで再判定する。

### v0.1.0 — Repository MVP

上記のProxy lifecycleを、packed packageとaccountless E2Eで証明する。

### v0.2.0 — Live Edge Alpha

選定したCloudflare primitiveとself-host pathを実accountで検証する。

- paid-plan runtimeをdeployする
- warmおよびcold/create p95を記録する
- same-tenant / multi-tenant concurrencyを記録する
- request、loader-call、provider cost evidenceを記録する
- Dynamic WorkersとWorkers for PlatformsのdecisionをADRでacceptする
- credentialを露出しないprotected Tier 2 environmentを運用する
- clean-account setup / apply / health / rollback / cleanupを完走する
- `@tenantscript/*` 0.x packagesをprovenance付きでpublishする、またはbootstrap boundaryを明記する

### v0.3.0 — Design Partner MVP

追加のinfrastructure breadthではなく、製品価値を検証する。

- qualified design partnerを1社得る
- 一つの狭いuse-case familyで3つのproductionまたはproduction-equivalent pluginを運用する
- 4週間連続で利用する
- agreed baseline比でmedian extension lead timeを50%以上短縮する
- rollback drillを5分以内で完了する
- cross-tenantまたはsecret exposure incidentを0件にする
- feedback-derived Issueを少なくとも3件作成してprioritizeする
- partnerがcontinue、pause、stopのいずれかを明示する

これは**true product MVP gate**である。

### v0.4.0 — Private Beta

- 3 host apps、または3つの独立したpartner environment
- active installation合計20以上
- provider capabilityとencrypted secret lifecycleのlive検証
- approval use caseを一つlive検証
- partner-derived load thresholdとrunaway isolation
- incident / rollback / restore drillを一つ完了
- unresolved critical incidentなしの4週間reliability window

### v0.5.0 — Public Beta

- public beta packageとreproducible install path
- fork-origin CI greenとintentional RED evidence
- independent security review完了、CRITICAL/HIGH解消
- 2名のindependent operatorがguide-only self-hostを完走
- quickstart、setup、doctor、upgrade、rollback、recovery journeyを検証
- public known-limitationsがlive evidenceを正確に反映

### v1.0.0 — Stable OSS

- 少なくとも3 organizationにまたがるproduction adopter 5社
- non-trivial contributionをmergeしたexternal contributor 3名
- independent security reviewでCRITICAL/HIGH zero
- release candidateのindependent self-host validation 2件
- live performance regression baselineとcost envelope
- release provenance、SBOM、clean install、upgrade、rollback evidence
- open v1 blocker zero
- benign reportによるvulnerability reporting pathの外部exercise
- stable APIとmigration policyのacceptance

### v1.1 — Ecosystem

- live gallery
- one-click template reuse
- first community templateとconnector
- trusted adoption / reuse counts
- case studies

### v1.2 — AI Authoring

- published reviewed judge image
- real isolated agent/model trials
- pass@1 / pass@3、duration、cost evidence
- monthly regression loop

### v2.0 Discovery — Runtime portability

- capability-runtime conformance
- WASM / Extism PoC
- theoretical lock-inではなくmeasured needに基づくadoption decision

### Product success metrics

Primary metrics:

- median customer-specific extension lead time
- core SaaS deployなしで出荷できたextensionの割合
- rollback MTTR
- 4週間後もretainedされるactive installationの割合

Guardrails:

- cross-tenant incident count
- secret exposure count
- plugin timeout / error rate
- added p95 latency
- installationあたりの月次operator hours
- 1,000 executionsあたりのCloudflare cost

v1.1以前のprimary metricではないもの:

- GitHub stars
- template count
- AI pass rate
- supported runtimes
- connector count

### Product decision rules

- current version gateのadoption evidenceが揃う前に、新しいruntime、provider、templateを追加しない。ただしgateを直接解除する場合を除く。
- design partner不足をv1.1のecosystem workで補填しない。
- repository simulationをproduction evidenceと呼ばない。
- broadなpartial integrationより、一つの狭いend-to-end journeyを優先する。
- qualified companyを20社へ連絡してもnarrow Proxy pilotに同意がない場合、feature追加前にpivot checkpointを開く。
- live added p95またはcostがinline executionに不適合なら、limitsを弱めずControl Planeを維持し、最初のuse caseをasynchronous webhook processingへ移す。

---

## 13. Distribution / Sustainability / OSS Strategy

Primary message:

> Stop hardcoding enterprise customer workflows.  
> Add safe customer-specific scripts to your SaaS without building a plugin platform from scratch.

初期デモ:

1. v0.1 Repository MVP: 2 tenantのWebhook payloadを別々のpinned transformで変換し、version updateとrollbackを確認する。
2. v0.2 Live Edge Alpha: 同じProxy journeyをCloudflare account上でsetup、benchmark、rollback、cleanupまで検証する。
3. v0.3 Design Partner MVP以降: partner evidenceに基づき、provider capability、approval、API policyを追加する。

配布はすべてOSSとし、収益化を目的としない(D-008)。運用形態は導入者自身のCloudflareアカウントでのself-hostのみ。これによりhosted版で生じるsub-processor / DPA / SOC2 / data residencyの問題は構造的に発生せず、エンタープライズSaaSも調達審査なしで採用できる。

### 段階的な導入パス(D-015)

| 段階 | 統合コスト | 提供価値 |
|---|---|---|
| ① Proxy mode | ほぼゼロ。outbound webhookの向き先を変えるだけ。 | v0.1ではWebhook transformationをコード変更なしで導入し、後続versionでnotification rulesへ拡張できる。 |
| ② SDK hooks | 本体にhookを定義する工事。 | transform / policy / approvalを含む全hook型。 |
| ③ Full control plane | self-host一式の運用。 | admin UI、audit、budget、version管理を含む全機能。 |

導入摩擦が最大の採用障壁であるため、①をドキュメントとデモの一級市民として扱う。

### Distribution(OSSとしての配布戦略)

- Cloudflare developer communityを主戦場にする: Workers templates、example app、ブログ / 登壇。
- Docs-first: 導入チュートリアル、threat model、self-hostガイドを最初から整備する。
- AI coding agentを配布チャネルとして扱う(D-016): llms.txt、型定義、scaffoldテンプレートを整備し、coding agentがpluginを正しく生成し、本プロジェクトを推薦できる状態を作る。
- ADOPTERS.mdで本番採用を可視化する。

### Sustainability(持続可能性モデル)

| 項目 | 方針 |
|---|---|
| 資金 | GitHub Sponsors / Buy Me a Coffee。CloudflareのOSSスポンサー制度(credits提供)に応募する。収益目標は持たない。 |
| 保守負荷 | coreを意図的に小さく保つ(D-007 / D-008)。connector追加要望はcapability interfaceの公開によりcommunityに委ねる。 |
| セキュリティ | SECURITY.md、脆弱性開示プロセス、advisory対応をv1.0までに整備する。security-critical OSSとしての信頼が採用の前提条件。 |
| Bus factor | governance文書とco-maintainer募集をv0.4 Private Betaから開始する。 |

### 競合との差別化

| カテゴリ | 代表 | 違い / 戦い方 |
|---|---|---|
| Embedded iPaaS | Paragon、Prismatic、Workato Embedded | 商用の代替候補。彼らはconnector配布とworkflow builder、本プロダクトはSaaS本体のhook内でのtenant-specific untrusted code実行。OSS self-hostは、ベンダーをデータパスに入れたくない・ロックインを避けたいチームの受け皿になる。 |
| End-user automation | Zapier、Pipedream、Make | SaaSの外側でend userが組む自動化。本プロダクトはSaaSの内側で運営者が商品として提供する拡張。connector数では戦わない。 |
| Plugin framework / WASM | Extism、Shopify Functions | ライブラリまたは単一プラットフォーム専用で、control plane(permission、versioning、audit、billing)を持たない。Extismは将来のruntime portability候補として補完関係。 |
| 内製(Cloudflare WfPを直接利用) | — | 最大の代替案。差別化はtime-to-market、permission UI、rollback、audit、journalなど運用面の蓄積。OSS coreで内製志向のチームも取り込む。 |
| 自社拡張プラットフォーム | Salesforce Apex、Shopify Apps | 競合ではなく参考モデル。「あれを、自社でプラットフォームを作れない汎用B2B SaaSに提供する」のが本プロダクト。 |

---

## 14. Risks / Mitigations

| Risk | 影響 | Mitigation |
|---|---|---|
| Cloudflareが上位レイヤーを公式提供する | OSSの存在意義が縮小する。 | 非商用OSSのため事業上の致命傷にはならない。早期にcommunity標準の地位を取り、公式化の際は統合・コラボを働きかける。manifest / capability modelが標準として残れば成果と見なす。 |
| 顧客がコードを書かない | self-serve marketplaceが伸びない。 | 初期はSolutions Engineer / SaaS運営者が書くprivate pluginから始める。 |
| Security責任が重い | secret leak、tenant data leak、egress事故が致命傷になる。 | capability-first、raw secret禁止、deny-by-default、audit、least privilegeをMVPから実装。 |
| メンテナの持続可能性(燃え尽き・bus factor 1) | security-criticalなインフラOSSは、保守が止まった時点で採用も止まる。 | coreを意図的に小さく保つ(D-007 / D-008)。CI自動化。SECURITY.mdと開示プロセス。GitHub Sponsors / Cloudflare OSSスポンサー制度。v0.4からgovernance文書とco-maintainer募集。 |
| コスト事故 | Dynamic Worker生成、CPU、subrequest、workflow runがCOGSを押し上げる。 | stable ID、version reuse、budget、usage dashboard、runaway disableを実装。 |
| Workflow / approval UIが複雑化 | MVPが肥大化する。 | v0.1はWebhook transformだけに限定し、approvalはv0.4以降へ送る。 |
| Zapier/Pipedream等と比較される | connector数で負ける。 | 外部connector数では戦わず、SaaS本体hook内のtenant-specific untrusted codeに絞る。 |
| Cloudflare専用への懸念 | 導入先が限定される。 | MVPは専用で良い。将来、manifestとcapability modelだけportableにする。 |

---

## 15. Open Questions

| テーマ | 確認すべき問い | 推奨アクション |
|---|---|---|
| Target segment | 最初の3社はどのSaaSカテゴリに絞るべきか。 | FinOps/Billing/Procurement SaaSに絞ったデモとLPを作る。 |
| Authoring model | 誰がpluginを書くのか。SaaS SE、顧客developer、AI、third-party partnerのどれが最初か。 | SE-authoredを前提にユーザーインタビューする。 |
| Permission UX | どの粒度までtenant adminに見せるか。 | Slack channel、invoice fields、workflow rolesの3例でpermission UIを試作。 |
| Cloudflare primitive choice | Dynamic Workers中心かWorkers for Platforms中心か。 | prototypeで両方のdeveloper experience、pricing、limitsを比較する。 |
| Data residency | tenant dataやlogsをどのregion / accountに置くか。 | v0.2のclean-account/self-host検証で、導入者のaccount境界と保存先を明記する。 |
| Marketplace timing | いつprivate template galleryからpublic marketplaceに進むか。 | v1.1でtrusted reuse evidenceが成立した場合だけ検討する。 |

---

## Appendix: Reference Links

- Cloudflare Dynamic Workers: https://developers.cloudflare.com/dynamic-workers/
- Dynamic Workers — Bindings: https://developers.cloudflare.com/dynamic-workers/usage/bindings/
- Dynamic Workers — Egress control: https://developers.cloudflare.com/dynamic-workers/usage/egress-control/
- Dynamic Workers — Pricing: https://developers.cloudflare.com/dynamic-workers/pricing/
- Cloudflare Workers for Platforms: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- Workers for Platforms — How it works: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- Workers for Platforms — Custom limits: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/custom-limits/
- Cloudflare Workflows: https://developers.cloudflare.com/workflows/
- Cloudflare Blog — Dynamic Workflows: https://blog.cloudflare.com/dynamic-workflows/
- Cloudflare Blog — EmDash WordPress: https://blog.cloudflare.com/emdash-wordpress/
- Pipedream Connect Docs: https://pipedream.com/docs/connect
- Inngest Docs: https://www.inngest.com/docs
- Extism GitHub: https://github.com/extism/extism

Accessed: 2026-06-11
