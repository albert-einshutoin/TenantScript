# TenantScript 開発プラン(設計・version gate・package boundaries)

[Product Thesis and Versioned MVP Plan](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) と Issue [#361](https://github.com/albert-einshutoin/TenantScript/issues/361) を実装に落とすための、TDDベースの開発計画。公開Issueの入口は [#41](https://github.com/albert-einshutoin/TenantScript/issues/41) とする。

## 完成の定義

**「完成」= v1.0.0 Stable OSS の Exit Gate を満たすこと**(第三者が支援なしでself-hostし、本番運用できる状態)。v1.1以降は完成後のecosystem育成・AI authoring・runtime portabilityとして扱う。

## Version gate map

Issue #361がversion、製品価値、ICP、success metricsの正本である。後続versionのfeature Issueは、前versionのcheckpointが明示的に進行を許可するまで着手しない。

| Version | 目的 | Exit evidence | 詳細 |
|---|---|---|---|
| v0.1.0 Repository MVP | credentialなしでtenant-specific Webhook transformation lifecycleを証明する | packed install、2 tenant、pinned transform、enable/disable/version/rollback、fail-closed E2E | [Product PRD §11](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#11-true-mvp--v010-repository-mvp) |
| v0.2.0 Live Edge Alpha | Cloudflare primitiveとself-host pathを実accountで検証する | paid-plan runtime、p95、concurrency、cost、protected Tier 2、clean-account、0.x package | [Product PRD §12](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#12-version-plan) |
| v0.3.0 Design Partner MVP | 一つの狭いuse-case familyで製品価値を検証する | 1 partner、3 plugins、4週間、lead time -50%、rollback MTTR ≤5分 | [Product PRD §12](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#12-version-plan) |
| v0.4.0 Private Beta | 複数環境とcapability/approvalのlive運用を検証する | 3環境、20 installations、live secret/capability、approval、reliability window | [Product PRD §12](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#12-version-plan) |
| v0.5.0 Public Beta | 独立install、security review、fork CIを検証する | public package、CRITICAL/HIGH zero、独立self-host、known limitations | [Product PRD §12](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#12-version-plan) |
| v1.0.0 Stable OSS | API安定性と持続可能なadoptionを確立する | 5 adopters、3 external contributors、独立self-host、release evidence、v1 blocker zero | [Product PRD §12](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md#12-version-plan) |

`Phase0.md`〜`Phase4.md`は過去の実装タスクを保持するlegacy trackであり、現在の製品versionやExit Gateを単独では定義しない。既存タスクを再開するときは、Issue #41 / #361のversion、scope、evidenceへ明示的に対応付ける。

## Roadmap governance

- Issue #41を実装Issueの入口とし、無関係なIssueから着手しない。
- 各versionのExit Reviewをcheckpointにし、前versionのevidenceなしに後続versionの実装へ進まない。
- 既存Phaseの未完了項目は、現versionのscopeを直接unblockするものだけを対応付け、外部証跡は別のblockerとして記録する。

## 言語選定

**決定: TypeScript に統一(D-017)。**

| 候補 | 評価 |
|---|---|
| **TypeScript** | ◎ 採用。Workers runtime(V8 isolate)のネイティブ言語。Dynamic Worker Loader / D1 / R2 / DO / Workflows の bindings が第一級。plugin author(SE / AI agent)と host SDK 導入先の主要言語。SDK / loader / control plane / CLI / UI を単一言語で構築でき、テスト資産も共有できる。 |
| Rust | △ 不採用(現時点)。workers-rs はあるが bindings が二級で、plugin が JS bundle である以上 loader 周りは結局 JS 境界を持つ。WASM sandbox や manifest 検証の高速化用途として v2.0 portability 検討(Extism 互換)時に再評価。 |
| Go | × 不採用。Workers の第一級サポートがない(TinyGo/WASM は制約大)。control plane を Workers 外に出すことになり、D-009(Cloudflare-native 集中)と矛盾する。 |

判断基準は「どの言語が好きか」ではなく、(1) 実行基盤が Workers であること、(2) plugin の書き手が TS を書くこと、(3) OSS 貢献者プール(Cloudflare コミュニティ ≒ TS コミュニティ)の3点。

## 技術スタック

| 領域 | 選定 | 備考 |
|---|---|---|
| 言語 | TypeScript(strict、ESM) | 全パッケージ共通 tsconfig |
| パッケージ管理 | pnpm workspaces(monorepo) | |
| スキーマ / 検証 | Zod | manifest、hook payload、installation config |
| テスト | Vitest + @cloudflare/vitest-pool-workers | unit は素の Vitest、integration は workerd 内で D1/R2/DO 実バインディング |
| E2E | example-saas 経由の workerd E2E、Admin UI は Playwright | |
| ローカル実行 | wrangler / Miniflare | |
| Lint / Format | ESLint + Prettier | PostToolUse hook と整合 |
| CI | GitHub Actions(2層: Tier 1 accountless / Tier 2 live) | Tier 1: typecheck → lint → test → audit → coverage(全 PR)。Tier 2: 実機・ベンチ(nightly) |
| バンドル | esbuild | plugin bundle(決定論的 hash)、CLI |
| UI | React + Vite | Admin UI(v0.4〜) |
| 計測 | Workers Analytics Engine | usage meter |

## リポジトリ構成(目標)

```text
tenantscript/
├── packages/
│   ├── manifest/        # manifest schema、configSchema 検証($config 解決含む)。依存ゼロの純TS
│   ├── plugin-sdk/      # definePlugin、ctx 型、continuation hook
│   ├── host-sdk/        # defineHooks、extensions.run、hook型・failure policy・実行計画
│   ├── loader/          # Dynamic Worker loader、scoped bindings、egress 制御、limits
│   ├── capabilities/    # capability broker(slack.send、approvals.request、invoice.read、…)
│   ├── control-plane/   # Control Plane API(D1 / R2 / DO / Workflows)
│   ├── proxy/           # webhook proxy mode(v0.1 Repository MVP、D-015)
│   └── cli/             # ext CLI(init / dev / build / replay / schema diff / deploy)
├── apps/
│   ├── example-saas/    # デモ用 host app(E2E とベンチの基盤)
│   └── admin-ui/        # Admin UI(v0.4〜)
├── docs/                # プロダクトドキュメント、ADR、benchmarks
└── tasks/               # 本計画
```

依存方向(逆流禁止): `manifest` ← `plugin-sdk` / `host-sdk` ← `loader` / `capabilities` ← `control-plane` ← `apps/*`

## TDD ワークフロー(全タスク共通)

各タスクは必ずこの順で進める。**実装より先にテストが存在しない変更はマージしない。**

1. **RED** — 失敗するテストを先に書く(各タスクの「RED:」が最初に書くテスト)
2. **GREEN** — テストを通す最小実装
3. **REFACTOR** — 重複排除・命名整理。テストは green のまま
4. **DoD 確認** — タスクの DoD とカバレッジ(package 単位 80%+)を確認し、チェックを付けてコミット

ルール:

- テストピラミッド: unit(Vitest)> integration(vitest-pool-workers で D1/R2/DO 実バインディング)> E2E(example-saas、Playwright)
- **adversarial security test を一級市民にする**: secret 露出・egress 逸脱・grant 昇格・tenant 越境の「攻撃テスト」は機能テストと同格で、各 Phase に常設チャンクを置く(本プロダクトの価値は security そのもの)
- AAA パターン、振る舞いが読めるテスト名(`returns empty array when no markets match query` 形式)
- flaky なタイムアウト待ちを書かない。決定論的な待機のみ
- TDD は「振る舞い」に適用する。インフラ・設定系タスク(scaffold、CI、リリース作業)は RED の代わりに**検証手順(verification checklist)**を DoD に定義する(形式的な設定テストで TDD を装わない)

## 品質ゲート(全 version gate 共通、CI で強制)

- typecheck / lint / test 全 green
- カバレッジ 80% 以上(package 単位。**計測は Day 1 から、gate強制はrepository MVPの基盤整備完了時から段階導入** — 空に近いpackageでの閾値ノイズを避ける)
- 依存脆弱性スキャン(pnpm audit 相当)green
- adversarial security suite green
- 各チャンク末尾の refactor タスク完了(コードレビュー込み)
- 1タスク = 1コミット以上。コミットは `<type>: <description>` 形式

## CI 2層戦略(OSS の fork PR 問題への対応)

| Tier | 実行環境 | 対象 | トリガー |
|---|---|---|---|
| **Tier 1: accountless** | workerd ローカル(vitest-pool-workers / Miniflare)。Cloudflare アカウント不要 | unit / integration / security suite / UI テスト | 全 PR 必須(**fork PR でも完走する**) |
| **Tier 2: live** | 実 Cloudflare アカウント(secrets 必要、実行コスト発生) | Worker Loader / WfP dispatch 実機、Workflows 実機、負荷・レイテンシベンチ | nightly + maintainer ブランチのみ |

テストは原則 Tier 1 で書く。Tier 2 でしか検証できないものは最小化し、該当タスクの DoD に「Tier 2」と明記する。Tier 2 の実行コストは記録して予算管理する。

## タスク表記

- ID: legacy trackでは`P<phase>-T<番号>`を使用する。新規Issueはversionとrelease gateを本文に明記する。サイズ: **S**(〜半日)/ **M**(〜1日)/ **L**(2〜3日。L は原則着手前にさらに分割)
- 各タスクは RED(最初に書くテスト。設定系タスクは検証手順で代替)→ GREEN(実装内容)→ DoD(完了条件)を持つ
- チェックボックスで進捗管理する
- タスク番号は**追加順のラベル**であり、ファイル内の記載順が推奨実行順(セルフレビュー反映 v1.1 で追加されたタスクは末尾番号を持つことがある)

## Legacy phase track map

| Legacy track | 現versionへの対応 | 役割 | ファイル |
|---|---|---|---|---|
| Phase 0 | v0.1 repository evidence + v0.2 live runtime evidence | 既存prototype、security、benchmark、runtimeの実装履歴 | [Phase0.md](Phase0.md) |
| Phase 1 | v0.1 lifecycle、v0.3 partner、v0.4 capability/approvalへ分割 | 既存MVP実装の詳細track | [Phase1.md](Phase1.md) |
| Phase 2 | v0.4 Private Beta | 複数app/tenant、RBAC、reliabilityの詳細track | [Phase2.md](Phase2.md) |
| Phase 3 | v0.5 Public Beta + v1.0 Stable OSS | self-host、security、release engineeringの詳細track | [Phase3.md](Phase3.md) |
| Phase 4 | v1.1 Ecosystem、v1.2 AI、v2.0 portability | version gate後の継続track | [Phase4.md](Phase4.md) |

前提: founding engineer 2名(1名なら期間約2倍)。v0.3以降のタスクはローリングウェーブ計画とし、**前versionのcheckpoint前に詳細化・再分割する**(後続versionほど粒度が粗いのは意図的)。
