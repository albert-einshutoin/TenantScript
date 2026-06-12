# Phase 2: Private Beta(2〜3ヶ月)

**ゴール:** 複数 host app・複数 tenant での実運用に耐える信頼性・権限・監査を作り、community 活動を開始する。

**Exit Gate:**

- [ ] host app 3社、active installation 20以上、weekly executions が4週連続で増加
- [ ] 重大 security incident 0件
- [ ] chaos / load テストが CI に常設され green
- [ ] GOVERNANCE.md / CONTRIBUTING.md 公開、co-maintainer 候補との会話開始
- [ ] security suite v3 green、カバレッジ 80%+ 維持

> 各タスクは Phase 1 終盤(P1-T40)で再分割する。以下は現時点の分解。TDD ワークフロー(RED→GREEN→REFACTOR)は全タスク共通。

---

## チャンク A: multi-app / multi-tenant 強化(T01–T04)

- [ ] **P2-T01**(M)D1 の app 単位シャーディング
  - RED: app 作成時に専用 D1 が割り当てられ、app 間でクエリが物理分離される(10GB 上限対策)
  - DoD: シャーディング下で全 integration テスト green

- [ ] **P2-T02**(M)tenant 越境の網羅テスト
  - RED: 全エンドポイント × 越境アクセスのマトリクステストを自動生成(エンドポイント追加時にテスト漏れすると fail する仕組み)
  - DoD: マトリクス green、security suite に常設

- [ ] **P2-T03**(M)並行実行の負荷テスト
  - 内容: 同一 tenant / 複数 tenant での同時 hook 実行(目標値は partner 実績から設定)。p95 レイテンシの劣化を計測
  - DoD: 負荷シナリオが CI(nightly)に入り、閾値超過で fail

- [ ] **P2-T04**(S)2つ目の example host app
  - 内容: 異なるドメイン(例: HR 系)の example app を追加し、hook schema が app 固有であることを実証
  - DoD: 両 example で E2E green

## チャンク B: RBAC(T05–T08)

- [ ] **P2-T05**(M)role model 設計 + 実装
  - RED: owner / admin / operator / viewer + tenant-admin の権限マトリクステストを先に書く(操作 × role の全組合せ)
  - DoD: マトリクステスト green

- [ ] **P2-T06**(M)grant 承認の権限分離
  - RED: capability grant の承認は admin 以上 / operator は install 申請のみ可能
  - DoD: 分離テスト green

- [ ] **P2-T07**(M)API トークン / サービス認証
  - RED: scope 付きトークン(read-only 等)が scope 外操作で拒否される / 失効が即時反映される
  - DoD: トークンテスト green、漏えい時の失効手順がドキュメント化

- [ ] **P2-T08**(S)RBAC 攻撃テスト
  - RED: 権限昇格パターン(自分の role 変更、他者への grant 付与経由の昇格)が全て拒否される
  - DoD: security suite v3 に追加

## チャンク C: audit & retention(T09–T11)

- [ ] **P2-T09**(M)audit log の不変化
  - RED: audit エントリの更新・削除 API が存在しない(write-once)/ hash chain で改ざん検知できる
  - DoD: 不変性・検知テスト green

- [ ] **P2-T10**(M)R2 アーカイブ + 保持ポリシー
  - RED: 設定した保持期間を過ぎた execution log が R2 へ移送され、D1 から消え、検索は R2 へフォールバックする
  - DoD: 移送・フォールバックのテスト green

- [ ] **P2-T11**(S)audit エクスポート
  - RED: 期間指定で NDJSON エクスポートできる(コンプライアンス提出用)
  - DoD: エクスポートテスト green

## チャンク D: capability pack v2(T12–T15)

- [ ] **P2-T12**(M)email.send
  - RED: grant の宛先ドメイン制限 / テンプレート外の本文注入防止
  - DoD: 機能 + 攻撃テスト green

- [ ] **P2-T13**(L→分割)brokered http.fetch
  - RED: allowlist 外 URL 拒否(リダイレクト追跡含む)/ credential injection(plugin に header を見せず broker が注入)/ audit 記録
  - DoD: D-005 の allowlist 実装として security suite 入り

- [ ] **P2-T14**(M)kv.state(DO facets)
  - RED: plugin ごとの durable state が plugin/tenant 境界で分離される / サイズ上限
  - DoD: 分離・上限テスト green

- [ ] **P2-T15**(S)capability contract test kit(社内版)
  - 内容: capability 実装が満たすべき契約(grant 照合・audit・rate limit・非露出)を共通テストとして抽出 — Phase 4 の community connector 基盤の前身
  - DoD: 既存 capability 全てが kit を通過

## チャンク E: schema evolution 運用(T16–T17)

- [ ] **P2-T16**(M)dual-publish
  - RED: hook schema v1/v2 並行配信中、plugin の互換 range に応じて正しい schema の payload が届く
  - DoD: 並行配信テスト green

- [ ] **P2-T17**(M)migration tracking
  - RED: 全 installation の対応 schema version が集計され、v1 利用ゼロになるまで v1 廃止操作がブロックされる
  - DoD: 追跡・ブロックのテスト green(Admin UI に表示)

## チャンク F: 信頼性(T18–T20)

- [ ] **P2-T18**(M)chaos テスト
  - 内容: 暴走 plugin(CPU/メモリ/再帰 hook)、broker 停止、D1 障害、R2 不達の注入テスト。**fail closed / fail open が hook 型どおりに働くことを検証**
  - DoD: chaos シナリオが nightly CI に常設

- [ ] **P2-T19**(M)runaway detection 改善
  - RED: 連続失敗・異常実行数の plugin が自動隔離(disable)され、管理者に通知される
  - DoD: 検知・隔離・復旧のテスト green

- [ ] **P2-T20**(S)障害 runbook
  - 内容: 主要障害(plugin 事故、capability 障害、budget 事故)の対応手順書
  - DoD: runbook どおりに drill を1回実施

## チャンク G: telemetry & community(T21–T24)

- [ ] **P2-T21**(M)opt-in telemetry
  - RED: opt-in しない限り一切送信されない(ネットワーク監視テスト)/ 送信内容に payload・secret・PII が含まれない
  - DoD: プライバシーテスト green、送信スキーマを公開ドキュメント化

- [ ] **P2-T22**(S)ADOPTERS.md + フィードバック導線
  - DoD: 採用報告の PR テンプレと issue テンプレが整備されている

- [ ] **P2-T23**(M)GOVERNANCE.md / CONTRIBUTING.md
  - 内容: 意思決定プロセス、レビュー基準(TDD 必須を明記)、co-maintainer の役割定義
  - DoD: 公開済み。good-first-issue を10件以上ラベル付け

- [ ] **P2-T24**(S)Phase 2 refactor + ゲートレビュー
  - 内容: 横断 refactor、カバレッジ確認、Exit Gate 消化、**Phase 3 タスクの再分割**
  - DoD: Exit Gate 全項目チェック、Phase3.md 最新化
