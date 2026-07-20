# Cloudflare-native SaaS Extension Control Plane

**Product Strategy & MVP Spec**  
**推奨名称:** Cloudflare-native Extension Control Plane for B2B SaaS(working title: TenantScript、旧称: SaaS Extension Runtime)  
**作成日:** 2026-06-11  
**更新日:** 2026-06-12 — v0.4: 実装言語決定(D-017: TypeScript)、開発計画は[tasks/](../tasks/README.md)参照。v0.3: pure OSS戦略(D-008改訂)、proxy mode(D-015)、AI coding agent前提(D-016)。v0.2: レビュー指摘反映(実行モデル、config、failure policy、KPIほか)  
**ステータス:** Working Draft — OSSプロジェクトのMVP定義に使えるレベル

---

## 最終方針

CloudflareのRuntimeを再発明しない。Dynamic Workers / Workers for Platforms / Workflowsをkernelとして使い、その上に「SaaS向け拡張機能の制御面・運用面・UX」を作る。

このプロダクトは、B2B SaaSが顧客ごとのコード・自動化・承認フロー・Webhook変換・API policy・通知ルール・AI agent toolを、安全に、監査可能に、version管理された形で実行できるようにするための **Extension Control Plane / Plugin OS** である。

---

## 1. Executive Summary

Cloudflare Dynamic Workers / Workers for Platforms / D1 / R2 / Durable Objects / Workflows は、untrusted codeを隔離して実行するための強いプリミティブを提供している。一方で、SaaS開発者がそのまま導入できるプロダクトレイヤー、つまりmanifest、permission UI、tenant secret管理、hook SDK、versioning、rollback、execution logs、billing meter、local dev、approval UIは薄い。

勝ち筋は「Cloudflareより良いRuntime」ではない。勝ち筋は、Cloudflare上で顧客別拡張を安全に運用するためのControl Plane、SDK、管理UI、運用規約、監査機能をまとめること。

| 評価軸 | 結論 |
|---|---|
| 市場性 | エンタープライズ顧客ごとの例外実装・自動化・連携要望は強い。Solutions Engineering工数削減に直結する。 |
| 技術タイミング | Cloudflareが必要なkernelを揃えつつある。上位レイヤーはまだプロダクト化余地がある。 |
| 最大リスク | メンテナの持続可能性(bus factor)。Cloudflare公式の上位レイヤー進出は非商用OSSには致命傷でなく、manifest / capability modelが標準として残れば成果と見なす。 |
| 初期勝ち筋 | Webhook transformation / notification rules / approval workflow / API policyを、SaaS運営者のSEが書くユースケースから始める。 |
| やらないこと | 最初からmarketplace、Zapier代替、汎用workflow builder、AI自動生成を中心にしない。 |

---

## 2. Product Thesis / Positioning

現在の名前「Cloudflare-native SaaS Extension Runtime」は方向性として良いが、「Runtime」という言葉はCloudflare公式と競合しやすい。プロダクトとしては、RuntimeではなくControl Planeとして再定義する。

| 項目 | 推奨方針 |
|---|---|
| カテゴリ | SaaS Extension Control Plane / Plugin OS |
| 一言説明 | B2B SaaSが顧客ごとの小さなコード・自動化・policy・承認を安全に実行するためのSDK + Control Plane + Admin UI。 |
| 英語コピー | Stop hardcoding enterprise customer workflows. |
| 日本語コピー | エンタープライズ顧客ごとの例外ロジックを、もう本体にハードコードしない。 |
| Cloudflareとの関係 | Cloudflare primitives are the kernel. This product is the SaaS extension operating system. |
| 類比 | Shopify Apps / Salesforce Apex / Zapier / WordPress Plugins の現代版。ただしB2B SaaS本体に埋め込む顧客別extension基盤。 |
| 事業形態 | pure OSS(D-008)。収益化を目的とせず、self-hostを唯一の運用形態とする。 |
| AI Coding時代の位置づけ | 顧客別コードを書くコストはAIで急落する。書くコストが下がるほど「安全に実行する場所」の需要は増える。本プロダクトはAI生成されたtenant codeのguardrail layerであり、AI時代に価値が増す側に立つ。 |

---

## 3. Decision Register

| ID | 決定 | 理由 / 影響 |
|---|---|---|
| D-001 | Control Planeとして位置づける | RuntimeそのものはCloudflareが公式に進化させる。自社の価値はmanifest、permission、logs、versioning、rollback、approval、billing、local devに置く。 |
| D-002 | 初期ユーザーはSaaS運営者・SE | 最初から顧客自身が自由にコードを書く前提にしない。Solutions Engineerが顧客別extensionを書く痛みから入る。 |
| D-003 | 初期ユースケースは4つに絞る | Webhook transformation、notification rules、approval workflows、API policyをMVPの主軸にする。AI agent toolは拡張先として扱う。 |
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
| D-015 | Proxy modeを導入の入口にする | SDK統合(本体へのhook工事)は最大の採用障壁。outbound webhookの向き先を変えるだけで使えるzero-integrationモードを用意し、webhook transformation / notification rulesを工事なしで体験させてからSDK統合に誘導する。 |
| D-016 | AI coding agentを前提に設計する | pluginの書き手は人間のSEだけでなくAIになる。typed SDK、manifest validation、capability sandbox、local replayはAI生成コードの安全装置として機能する。docs / llms.txt / scaffoldをagent-friendlyに整備し、配布チャネルとしても扱う。 |
| D-017 | 実装言語はTypeScriptに統一する | Workers runtime(V8 isolate)のネイティブ言語であり、Dynamic Worker Loader / D1 / R2 / DO / Workflowsのbindingsが第一級。plugin author(SE / AI agent)とhost SDK導入先の主要言語でもある。SDK / loader / control plane / CLI / UIを単一言語にしてOSS貢献障壁を下げる(D-008と整合)。Rust/WASMはPhase 4のportability検討時に再評価。GoはWorkers第一級サポートがなくD-009と矛盾するため不採用。 |

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

| ICP | 刺さる理由 | 初期メッセージ |
|---|---|---|
| Vertical B2B SaaS | 業界・顧客ごとの業務ルールが多く、例外対応が発生しやすい。 | 顧客別の業務ルールを安全なextensionに分離。 |
| FinOps / Billing / Procurement SaaS | 金額閾値、承認、Slack通知、請求・購買policyが多い。 | 請求・購買まわりの例外ロジックを本体にハードコードしない。 |
| HR / ATS / RevOps / CRM-adjacent SaaS | 顧客別通知、ワークフロー、外部同期、Webhook変換が多い。 | 顧客別workflowを短いコードで導入。 |
| Security / Compliance SaaS | tenantごとのpolicy-as-code需要がある。 | 顧客別policyを監査可能に実行。 |
| AI agent SaaS | 顧客ごとのtools、secret、approval、egress controlが必要。 | agent toolをtenant-scoped capabilityとして安全に提供。 |
| Developer-facing SaaS | 顧客側にdeveloper/adminがおり、コードベースのcustomizationを受け入れやすい。 | typed hooksで自社SaaSをprogrammableにする。 |

OSSとしての初期採用は、OSS導入への抵抗が最も低いDeveloper-facing SaaSと、capability / approval / egress制御の需要が最も切実なAI agent SaaSから始まる可能性が高い。メッセージングはSEの痛みを軸に保ちつつ、この2セグメントをearly adopter候補として優先する。

### Personas

| Persona | 役割 | 痛み / 評価基準 |
|---|---|---|
| Economic buyer: VP Engineering / CTO(従業員50〜500名のB2B SaaS) | 予算決裁。内製との比較判断。 | エンタープライズ案件の個別要望がロードマップと採用計画を圧迫している。time-to-marketと運用リスクで判断する。 |
| Champion / 主要ユーザー: Solutions Engineer / Forward-deployed engineer | pluginを書き、顧客別に出荷する。 | 顧客別実装がbackend deploy待ちで数週間かかる。自分のコードが本体を壊す事故への恐怖。 |
| 副次: Product Manager | 例外要望のトリアージ。 | 「本体機能化するか、extensionで逃がすか」の判断材料が欲しい。 |
| 副次: Security / Compliance担当 | capability grantの審査、audit確認。 | 顧客別コードが何にアクセスできるかを説明できないと審査を通せない。 |
| 副次: Tenant admin(顧客側) | installの承認、approval対応。 | 自社向けロジックの権限と動作履歴が見えること。 |

### Jobs to be Done

- エンタープライズ見込み客が契約条件として個別承認フローを要求したとき、本体をフォークせずに出荷し、ロードマップを担保に入れずに受注したい。
- 顧客固有の自動化が深夜に壊れたとき、その顧客のロジックだけを止めて巻き戻し、影響範囲を1テナントに閉じたい。
- 顧客のセキュリティ審査で「この顧客別コードは何にアクセスできるのか」と問われたとき、manifestとgrantとaudit logで即答して調達を通過したい。

---

## 6. Scope / Use Cases

| 優先度 | Use Case | 理由 | MVP対応 |
|---|---|---|---|
| P0 | Webhook transformation | 導入が最も軽く、顧客別変換ロジックの痛みが明確。 | Yes |
| P0 | Notification rules | Slack/Teams/Email通知はcapability modelを説明しやすい。 | Yes |
| P0 | Approval workflows | 金額や状態に応じた人間の承認待ちはB2B SaaSで頻出。 | Yes, basic |
| P1 | API policy | tenantごとのAPI allow/deny/modifyを実装できるとsecurity/compliance系に刺さる。 | Partial |
| P1 | AI agent tool | 将来的に強いが、初期メッセージにしすぎると流行語に見える。 | Later |
| P2 | Public marketplace | 配布面は強いが初期は供給側不足になりやすい。 | No |

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
    type: "event",              // 並列実行、non-blocking、fail-open
    schema: invoiceCreatedSchemaV1,  // versioned payload schema
  },
  "webhook.outbound": {
    type: "transform",          // Installation.priority順の直列チェーン
    onPluginFailure: "skip",    // 失敗pluginはスキップし、元のpayloadを次段へ
    budgetMs: 500,
  },
  "api.request": {
    type: "policy",             // 直列。allow/deny/modifyを返す
    onPluginFailure: "deny",    // fail-closed
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
7. transform hookは前段の出力payloadを後段の入力にする。policy hookはallow/deny/modifyを返し、denyの時点でチェーンを打ち切る。
8. 結果、ログ、duration、error、usageをExecutionとして保存する。
9. ctx.approvals.request()が呼ばれた場合、Workflowが承認のライフサイクル(通知、リマインド、エスカレーション、期限切れ)を管理し、決定時にresumeHookを新しいexecutionとして起動する。plugin実行自体はsuspendしない(D-011)。
10. 失敗時はhookのfailure policy(event: fail-open / transform: skipまたはabort / policy: fail-closed)に従い、retry、plugin disable、rollback候補を提示する。

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

transform / policy hookはhost本体のrequest pathに入るため、SLOを設けてPhase 0で実測検証する。

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
| Failure policyはhook型で決まる | policy hookはfail-closed(deny)、event hookはfail-open(本体処理を止めない)、transform hookはskip / abortをhost側で宣言する。manifest不一致、grant不足、secret missing、budget超過による「実行可否」の判断は常にfail-closed(実行しない)。 |

---

## 11. MVP v0.1

MVPのゴール:

> 1つのB2B SaaSが、自社のinvoice.created hookに顧客別pluginをinstallし、Slack通知とmanager approvalを安全に実行し、ログを見てrollbackできる。

| Priority | Feature | Deliverable | Acceptance Criteria |
|---|---|---|---|
| P0 | Host SDK | hook定義(型: event/transform/policy、failure policy、budgetMs)、tenantId付きrun、schema validation、result handling。 | サンプルSaaSからinvoice.createdを発火でき、schema違反payloadは拒否される。 |
| P0 | Plugin SDK | definePlugin、typed event、ctx capability、ctx.config、continuation hook(resumeHook)。 | Plugin authorが型付きでhandlerとctx.configを使える。 |
| P0 | Manifest schema | hooks(schema互換range)、configSchema、capabilities、egress、limitsを宣言。 | CI/CLIでinvalid manifestと必須config未充足を検出できる。 |
| P0 | Dynamic Worker loader | plugin artifactをversion hashでloadし、scoped bindingsとctx.configを渡す。 | 同一versionはstable IDで再利用される。 |
| P0 | Capability broker | slack.send、approvals.request、invoice.readの3つ。Slack OAuth app、tenant単位のworkspace接続フロー、token保管(broker内)を含む。 | raw secretをpluginに露出しない。tenant adminがSlack workspace接続を完了できる。 |
| P0 | Approval decision API / CLI | approvals.requestで作られた承認をAPI/CLIでapprove/rejectし、resumeHookを起動する。 | API経由の承認決定でcontinuation hookが実行され、audit logに残る。 |
| P0 | Execution logs | status、duration、error、capability calls、versionを保存・表示。 | adminがtenant/plugin/hookで検索できる。 |
| P0 | Version pinning / rollback | installationごとにversion固定し、前versionへ戻せる。 | UIまたはCLIで即時rollbackできる。 |
| P0 | Egress policy | deny-by-default。allowlistはv0.1では限定実装。 | 無許可fetchは失敗し、ログに残る。 |
| P0 | Budget cap | tenant×pluginのdaily execution / CPU予算。超過時はauto-disableして管理者に通知(D-010のenforcement)。 | budget超過でpluginが自動停止し、Executionにbudget_exceededが記録される。 |
| P1 | Approval UI | basic approval queue、approve/reject、audit log。 | manager roleに承認待ちを表示できる。 |
| P1 | Local dev / replay | sample eventでlocal run、manifest lint、replay。 | 本番event sampleを使ってversion変更前にテストできる。 |
| P1 | Usage meter | executions、cpuMs、subrequests、workflow runsを集計・可視化(enforcementはBudget capが担う)。 | tenant/plugin別COGSが見える。 |

MVPで作らないもの:

- Public marketplace
- 汎用workflow builder
- 多数のexternal connectors
- AI plugin generator
- non-Cloudflare runtime対応
- 顧客自身による自由編集UI

---

## 12. Roadmap

前提: founding engineer 2名 + Phase 1以降はdesign partner 1社。1名体制の場合は期間を約2倍で見る。

| Phase | 期間イメージ | 主なDeliverable | 検証したいこと |
|---|---|---|---|
| Phase 0: Prototype | 2〜4週間 | host SDK、plugin SDK、manifest、loader、1 hook、1 capability、basic logs。 | Cloudflare上で安全にtenant pluginを実行できるか。blocking hookのp95 overhead実測。Dynamic Workers vs Workers for Platformsの比較結論。 |
| Phase 1: MVP | 1〜2ヶ月 | version pinning、rollback、permission UI、approval basic、local replay、usage meter、webhook proxy mode(zero-integration導入パス)。 | SaaS運営者が顧客別extensionを本番に近い形で運用できるか。proxy modeだけで価値を実感できるか。 |
| Phase 2: Private Beta | 2〜3ヶ月 | 複数host app、複数tenant、audit retention、role model、more capabilities。 | 実顧客のcustomization痛みに対して継続利用されるか。 |
| Phase 3: v1.0 Production-ready | 3〜6ヶ月 | self-host用admin UI完成、secret broker、外部security review、SECURITY.md / advisory process、upgrade guide、agent-friendly docs(llms.txt)。 | 第三者が支援なしでself-hostし、本番運用できるか。 |
| Phase 4: Ecosystem | 6ヶ月以降 | community template gallery、plugin review guideline、AI-assisted plugin authoring。 | 再利用可能なplugin supplyがcommunityから生まれるか。 |

### 成功指標とPhase gates

North Star候補: **本番稼働中のactive installation数**(weekly executions > 0のinstallation)。OSSのため計測はopt-in telemetryとADOPTERS.md(自己申告)で近似する。

| Phase | Gate(次フェーズに進む条件) |
|---|---|
| Phase 0 | E2Eデモが成立する。blocking hookのp95 added latencyがwarmで50ms未満。raw secret露出・egress逸脱の既知経路ゼロ。 |
| Phase 1 | design partner 1社の本番hookでplugin 3つ以上が4週間連続稼働。SEの顧客別実装リードタイムがベースライン比50%短縮。rollback MTTR 5分未満。 |
| Phase 2 | host app 3社、active installation 20以上、weekly executionsが4週連続で増加。重大security incident 0件。 |
| Phase 3 | ADOPTERS.md記載の本番採用5社以上。外部contributorのmerged PR 10件以上。脆弱性報告への対応プロセスが少なくとも1回実運用されている。 |

---

## 13. Distribution / Sustainability / OSS Strategy

Primary message:

> Stop hardcoding enterprise customer workflows.  
> Add safe customer-specific scripts to your SaaS without building a plugin platform from scratch.

初期デモ:

1. Webhook transformer: 顧客ごとにpayloadを変換する。
2. Invoice approval workflow: 金額条件でSlack通知し、manager approvalを待つ。
3. API policy hook: tenantごとにAPI requestを許可・拒否・修正する。

配布はすべてOSSとし、収益化を目的としない(D-008)。運用形態は導入者自身のCloudflareアカウントでのself-hostのみ。これによりhosted版で生じるsub-processor / DPA / SOC2 / data residencyの問題は構造的に発生せず、エンタープライズSaaSも調達審査なしで採用できる。

### 段階的な導入パス(D-015)

| 段階 | 統合コスト | 提供価値 |
|---|---|---|
| ① Proxy mode | ほぼゼロ。outbound webhookの向き先を変えるだけ。 | webhook transformationとnotification rulesをコード変更なしで導入。価値の実感が先、工事は後。 |
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
| Bus factor | governance文書とco-maintainer募集をPhase 2から開始する。 |

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
| メンテナの持続可能性(燃え尽き・bus factor 1) | security-criticalなインフラOSSは、保守が止まった時点で採用も止まる。 | coreを意図的に小さく保つ(D-007 / D-008)。CI自動化。SECURITY.mdと開示プロセス。GitHub Sponsors / Cloudflare OSSスポンサー制度。Phase 2からgovernance文書とco-maintainer募集。 |
| コスト事故 | Dynamic Worker生成、CPU、subrequest、workflow runがCOGSを押し上げる。 | stable ID、version reuse、budget、usage dashboard、runaway disableを実装。 |
| Workflow / approval UIが複雑化 | MVPが肥大化する。 | v0.1ではapproval queueのみ。複雑なbranching UIは後回し。 |
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
| Data residency | tenant dataやlogsをどのregion / accountに置くか。 | v0.3で解消: pure OSS self-host前提のため、データは導入者自身のCloudflareアカウントから出ず、sub-processor / DPA問題は構造的に発生しない。 |
| Marketplace timing | いつprivate template galleryからpublic marketplaceに進むか。 | 3社以上で同一plugin templateが再利用されたら検討。 |

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
