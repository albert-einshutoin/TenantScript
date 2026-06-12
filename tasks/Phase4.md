# Phase 4: Ecosystem(6ヶ月〜、継続)

**ゴール:** 再利用可能な plugin supply が community から生まれる状態を作る。完成(v1.0)後の継続フェーズであり、終了日を持たない。

**Exit Gate(四半期ごとに見直し):**

- [ ] template が3社以上で再利用される(プロダクトドキュメント §15 の marketplace 判断条件)
- [ ] community 製 capability connector が contract test kit を通過して1つ以上マージされる
- [ ] co-maintainer 1名以上が定常レビューに参加
- [ ] AI 生成 plugin の合格率(eval harness)を計測し、四半期で改善

> タスクは Phase 3 終盤(P3-T22)で再分割する。TDD ワークフローは全タスク共通。

---

## チャンク A: template gallery(T01–T03)

- [ ] **P4-T01**(M)template リポジトリ + 基準
  - 内容: 初期デモ3種(webhook transformer / invoice approval / API policy)を template 化。**全 template にテストと manifest を同梱することを基準化**
  - DoD: `ext init --template <name>` で取得 → build → test が green

- [ ] **P4-T02**(M)gallery サイト
  - 内容: template 一覧の静的サイト(Workers Assets)。検索・タグ・再利用数の表示
  - DoD: E2E smoke green、ADOPTERS と連動

- [ ] **P4-T03**(S)template 投稿ガイドライン
  - 内容: 投稿要件(テスト同梱、capability 最小権限、ライセンス)、レビューフロー
  - DoD: community からの初投稿がガイドラインのみで完走

## チャンク B: plugin review & 配布品質(T04–T06)

- [ ] **P4-T04**(M)`ext audit`(自動検査)
  - RED: 過剰 capability 要求(未使用 grant)、egress 宣言漏れ、limits 過大、テスト不在を検知する
  - DoD: 既知の悪性/粗悪パターン fixture を全検知

- [ ] **P4-T05**(S)plugin review ガイドライン
  - 内容: 人間レビューの観点表(security / 互換性 / 運用)。certification チェックリスト
  - DoD: 公開済み、template レビューに適用

- [ ] **P4-T06**(S)バージョン互換ダッシュボード
  - 内容: template/plugin の SDK バージョン互換状況の可視化
  - DoD: gallery サイトに表示

## チャンク C: AI-assisted authoring(T07–T09)— D-016

- [ ] **P4-T07**(M)scaffold プロンプト & レシピ集
  - 内容: coding agent 向けの「plugin 作成レシピ」(要件 → manifest → テスト → handler の TDD 手順をプロンプト化)
  - DoD: 代表3ユースケースで agent が一発で green な plugin を生成

- [ ] **P4-T08**(L→分割)AI 生成 plugin の eval harness
  - RED: 「自然言語要件 → 生成 plugin」が (1) manifest valid (2) テスト green (3) security suite 通過 (4) `ext audit` 通過、を自動判定するハーネスを先に作る
  - GREEN: 要件コーパス(10件〜)で合格率を計測し、docs/scaffold の改善にフィードバック
  - DoD: 合格率がダッシュボード化され、四半期 KPI になる

- [ ] **P4-T09**(S)llms.txt / docs の継続改善
  - 内容: eval harness の失敗パターンから docs を改訂するループを月次化
  - DoD: 改訂が eval 合格率の改善として計測される

## チャンク D: portability 研究(T10–T12)

- [ ] **P4-T10**(M)manifest / capability model の独立仕様化
  - 内容: 実装から独立した仕様文書(他 runtime でも実装可能な形式)。標準化が「Cloudflare 公式化リスク」への最終的な答えになる
  - DoD: spec 文書公開、適合テストスイート(実装非依存)の骨子

- [ ] **P4-T11**(L→分割)Extism / WASM PoC
  - 内容: capability broker インターフェースを WASM 境界で再現できるかの検証(Rust 再評価はここで実施 — D-017 の見直し条件)
  - DoD: PoC 結果を ADR 化(採用 / 不採用 / 条件付き)

- [ ] **P4-T12**(S)Dynamic Workflows 等の新 primitive 追従
  - 内容: Cloudflare 新機能の四半期評価(採用判断は ADR で記録)
  - DoD: 四半期レビューが定例化

## チャンク E: community 運営(T13–T15)

- [ ] **P4-T13**(M)community connector 受け入れ
  - 内容: capability contract test kit(P2-T15)を公開 SDK 化し、サードパーティ capability の受け入れフローを確立
  - DoD: 外部製 connector 1つが kit 通過でマージ

- [ ] **P4-T14**(S)showcase / 採用事例
  - 内容: ADOPTERS の事例化(ブログ/トーク)。Cloudflare community への露出
  - DoD: 事例2本公開

- [ ] **P4-T15**(S)四半期 roadmap 公開運用
  - 内容: roadmap issue の公開運用、Exit Gate の四半期見直し
  - DoD: 初回 roadmap 公開、レビューサイクル定着
