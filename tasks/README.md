# TenantScript 開発プラン(設計 & フェーズ別タスク)

[プロダクトドキュメント v0.4](../docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) を実装に落とすための、TDDベース・フェーズ分割の開発計画。

## 完成の定義

**「完成」= Phase 3 の Exit Gate を満たす v1.0 リリース**(第三者が支援なしで self-host し、本番運用できる状態)。Phase 4 は完成後の継続的な ecosystem 育成フェーズとして扱う。

## 言語選定

**決定: TypeScript に統一(D-017)。**

| 候補 | 評価 |
|---|---|
| **TypeScript** | ◎ 採用。Workers runtime(V8 isolate)のネイティブ言語。Dynamic Worker Loader / D1 / R2 / DO / Workflows の bindings が第一級。plugin author(SE / AI agent)と host SDK 導入先の主要言語。SDK / loader / control plane / CLI / UI を単一言語で構築でき、テスト資産も共有できる。 |
| Rust | △ 不採用(現時点)。workers-rs はあるが bindings が二級で、plugin が JS bundle である以上 loader 周りは結局 JS 境界を持つ。WASM sandbox や manifest 検証の高速化用途として Phase 4 の portability 検討(Extism 互換)時に再評価。 |
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
| CI | GitHub Actions | typecheck → lint → test → coverage gate(80%) |
| バンドル | esbuild | plugin bundle(決定論的 hash)、CLI |
| UI | React + Vite | Admin UI(Phase 1〜) |
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
│   ├── proxy/           # webhook proxy mode(Phase 1、D-015)
│   └── cli/             # ext CLI(init / dev / build / replay / schema diff / deploy)
├── apps/
│   ├── example-saas/    # デモ用 host app(E2E とベンチの基盤)
│   └── admin-ui/        # Admin UI(Phase 1〜)
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

## 品質ゲート(全 Phase 共通、CI で強制)

- typecheck / lint / test 全 green
- カバレッジ 80% 以上(package 単位)
- adversarial security suite green
- 各チャンク末尾の refactor タスク完了(コードレビュー込み)
- 1タスク = 1コミット以上。コミットは `<type>: <description>` 形式

## タスク表記

- ID: `P<phase>-T<番号>`。サイズ: **S**(〜半日)/ **M**(〜1日)/ **L**(2〜3日。L は原則着手前にさらに分割)
- 各タスクは RED(最初に書くテスト)→ GREEN(実装内容)→ DoD(完了条件)を持つ
- チェックボックスで進捗管理する

## フェーズ一覧

| Phase | 目的 | 期間目安 | Exit Gate(要約) | ファイル |
|---|---|---|---|---|
| 0 | Prototype — 安全に tenant plugin を実行できる証明 | 2〜4週 | E2E デモ成立、p95 warm < 50ms、secret/egress 逸脱ゼロ、runtime 選定 ADR | [Phase0.md](Phase0.md) |
| 1 | MVP — 本番運用形(version / rollback / approval / budget / proxy / CLI / UI最小) | 1〜2ヶ月 | design partner 1社で plugin 3つ×4週稼働、rollback MTTR < 5分 | [Phase1.md](Phase1.md) |
| 2 | Private Beta — 複数 app / tenant、RBAC、信頼性、community 開始 | 2〜3ヶ月 | host app 3社、active installation 20+、重大 incident 0 | [Phase2.md](Phase2.md) |
| 3 | v1.0 — production-ready OSS | 3〜6ヶ月 | adopter 5社、外部 contributor PR 10件、advisory 運用実績 | [Phase3.md](Phase3.md) |
| 4 | Ecosystem — community supply とポータビリティ | 6ヶ月〜 | template 再利用の発生、community connector の成立 | [Phase4.md](Phase4.md) |

前提: founding engineer 2名(1名なら期間約2倍)。Phase 2 以降のタスクはローリングウェーブ計画とし、**前 Phase の終盤に詳細化・再分割する**(後続 Phase ほど粒度が粗いのは意図的)。
