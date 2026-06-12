# Phase 1: MVP(1〜2ヶ月)

**ゴール:** プロダクトドキュメント §11 MVP v0.1 の達成 —「1つの B2B SaaS が invoice.created hook に顧客別 plugin を install し、Slack 通知と manager approval を安全に実行し、ログを見て rollback できる」。加えて proxy mode(D-015)で zero-integration の導入パスを成立させる。

**Exit Gate:**

- [ ] design partner 1社の本番 hook で plugin 3つ以上が4週間連続稼働
- [ ] SE の顧客別実装リードタイムがベースライン比 50% 短縮(partner と合意した計測方法で)
- [ ] rollback MTTR 5分未満(drill で実測)
- [ ] proxy mode 単体で価値を実感できる(partner ヒアリング)
- [ ] security suite v2 green、全 package カバレッジ 80%+

**スコープ外(Phase 2 に送る):** RBAC、audit retention、email/http capability、schema dual-publish、telemetry。

---

## チャンク A: ドメイン・永続化の完成(T01–T04)

- [ ] **P1-T01**(M)plugin / version 登録 API
  - RED: manifest + artifact を登録 → version 一覧取得 / 同一 version 再登録は拒否(immutable)
  - GREEN: control-plane に plugin/version エンドポイント実装
  - DoD: 登録・重複拒否・一覧のテスト green

- [ ] **P1-T02**(M)installation CRUD + grant + config
  - RED: install 時に manifest 要求 capability と grant の照合 / configSchema 検証(required 欠落で install 失敗)/ priority 設定
  - GREEN: installation エンドポイント実装(D-013 のサーバ側)
  - DoD: install / update config / enable / disable / 優先度変更のテスト green

- [ ] **P1-T03**(S)tenant / app 管理最小 API
  - RED: app 作成 → tenant 作成 → installation がその配下にスコープされる(越境参照は 404/403)
  - GREEN: app/tenant エンドポイント
  - DoD: スコープテスト green(security suite にも追加)

- [ ] **P1-T04**(S)チャンク A refactor
  - DoD: API エラー形状の統一(エラー envelope)、重複排除。lint/型/テスト green

## チャンク B: versioning & rollback(T05–T07)

- [ ] **P1-T05**(M)version pinning
  - RED: installation が version を pin し、実行時に必ず pinned version が解決される / pin 先 version が存在しないと失敗
  - GREEN: 解決ロジックを control-plane に実装(D-006)
  - DoD: pin・解決・不存在のテスト green

- [ ] **P1-T06**(M)rollback API + CLI
  - RED: rollback 実行 → 次回実行から旧 version が使われる / rollback 自体が audit log に残る
  - GREEN: rollback エンドポイント + `ext rollback` コマンド
  - DoD: API/CLI 双方のテスト green

- [ ] **P1-T07**(S)rollback drill(MTTR 計測)
  - 内容: 「壊れた version を deploy → 検知 → rollback 完了」までの手順書と計測スクリプト
  - DoD: drill 実施で MTTR < 5分を記録(`docs/benchmarks/` に追記)

## チャンク C: approvals(T08–T13)

- [ ] **P1-T08**(M)approvals.request capability
  - RED: plugin から request → Approval レコードが作成され、**handler はそこで正常終了する**(suspend しないこと自体をテスト、D-011)
  - GREEN: capability 実装 + Approval 永続化(role / subject / resumeHook / expiresAt)
  - DoD: 作成・即時終了・grant 外 role 拒否のテスト green

- [ ] **P1-T09**(M)approval lifecycle(Workflows)
  - RED: 期限切れで expired に遷移 / リマインド予定が生成される(時間は Workflows のテスト機構でモック)
  - GREEN: Cloudflare Workflows で通知・リマインド・期限切れを管理
  - DoD: 状態遷移(pending → approved/rejected/expired)テスト green

- [ ] **P1-T10**(M)decision API + CLI
  - RED: approve/reject で state 遷移 / 二重決定は拒否 / 決定者と理由が audit に残る
  - GREEN: decision エンドポイント + `ext approvals approve|reject`
  - DoD: 決定・二重決定拒否・audit のテスト green

- [ ] **P1-T11**(M)resumeHook continuation 実行
  - RED: approve 決定 → resumeHook が**新しい execution として**起動し、decision payload(approved/rejected、subject)を受け取る
  - GREEN: decision → loader 起動の接続(D-011 の完成)
  - DoD: E2E(request → decision → continuation)green

- [ ] **P1-T12**(S)approval 攻撃テスト
  - RED: 権限のない role による決定 / 他 tenant の approval への決定 / resumeHook の偽装呼び出し — 全て拒否されること
  - DoD: security suite に追加され green

- [ ] **P1-T13**(S)チャンク C refactor
  - DoD: approval 状態機械を独立モジュール化し、状態遷移表をテストと1対1対応させる

## チャンク D: 冪等性 journal(T14–T15)

- [ ] **P1-T14**(M)capability call journal(DO)
  - RED: 同一 execution の retry で、journal 済み capability call が**実行されずに**前回結果を返す(モック Slack の受信が1回であることを検証、D-014)
  - GREEN: Durable Object journal + broker 統合
  - DoD: retry 二重送信防止テスト green

- [ ] **P1-T15**(S)retry policy
  - RED: event hook は at-least-once retry(journal 併用)/ transform・policy は retry しない(failure policy に従う)
  - GREEN: hook 型別 retry 実装
  - DoD: hook 型 × 失敗ケースのマトリクステスト green

## チャンク E: budget cap(T16–T18)

- [ ] **P1-T16**(M)usage カウンタ(DO)
  - RED: tenant×plugin の daily executions / cpuMs が加算され、日付境界でリセットされる
  - GREEN: DO ベースのカウンタ(D-010)
  - DoD: 加算・境界・並行加算(競合)テスト green

- [ ] **P1-T17**(M)超過時 auto-disable
  - RED: budget 超過の次の実行が拒否され、execution に `budget_exceeded` が記録され、installation が disabled になり、管理者通知イベントが発行される
  - GREEN: 実行前チェック + disable + 通知
  - DoD: 超過系テスト green。**復旧手順(re-enable)もテスト**

- [ ] **P1-T18**(S)budget 攻撃テスト
  - RED: 並行実行による budget 競り抜け / カウンタ初期化の悪用 — 防止されること
  - DoD: security suite に追加され green

## チャンク F: capability 拡張(T19–T21)

- [ ] **P1-T19**(M)invoice.read capability
  - RED: grant の fields 指定外のフィールドが**結果に含まれない** / tenant 越境の invoice 参照拒否
  - GREEN: field filtering 付き read capability
  - DoD: フィルタ・越境拒否テスト green

- [ ] **P1-T20**(L→着手時分割)Slack OAuth 接続フロー
  - RED: OAuth callback → token が secret store に保存され、**API レスポンスやログに token が一切現れない**
  - GREEN: Slack OAuth app、tenant 単位の workspace 接続、token 保管(broker 内)
  - DoD: 接続フロー integration テスト + token 非露出テスト green

- [ ] **P1-T21**(S)capability 共通レート制限(最小)
  - RED: capability ごとの rateLimit 超過で拒否され、audit に残る
  - GREEN: DO ベースの簡易 rate limiter
  - DoD: 上限・回復のテスト green

## チャンク G: proxy mode(T22–T24)— D-015

- [ ] **P1-T22**(M)webhook proxy worker
  - RED: inbound webhook → tenant 解決 → transform チェーン適用 → 元の宛先へ転送、が E2E で通る / 変換失敗時は failure policy(skip)で原文転送
  - GREEN: `packages/proxy` 実装(host SDK の transform 実行計画を再利用)
  - DoD: 変換・skip・転送のテスト green

- [ ] **P1-T23**(S)proxy mapping 設定
  - RED: 宛先 URL の allowlist 検証(任意 URL への転送を拒否 = SSRF 防止)
  - GREEN: mapping CRUD(inbound path → 宛先、tenant 対応)
  - DoD: mapping テスト + SSRF 防止テスト green(security suite 追加)

- [ ] **P1-T24**(M)zero-integration quickstart
  - 内容: 「Stripe/GitHub いずれかの実 webhook を 15分で変換する」チュートリアル + E2E 化
  - DoD: チュートリアル手順がそのまま CI の E2E として動く(docs のコード断片をテストから参照)

## チャンク H: CLI(T25–T29)

- [ ] **P1-T25**(S)`ext init`
  - RED: 生成された scaffold が `ext build` でそのまま通る(生成物の自己検証)
  - GREEN: plugin scaffold 生成(manifest + handler + テスト雛形 — **雛形にもテストを含める**)
  - DoD: scaffold → build → test が一発で green

- [ ] **P1-T26**(M)`ext dev` + `ext build`
  - RED: build の決定論 hash(P0-T15 再利用)/ dev でローカル実行(Miniflare)し、モック capability が繋がる
  - GREEN: dev サーバ + build コマンド
  - DoD: dev/build のテスト green

- [ ] **P1-T27**(M)`ext replay`
  - RED: 本番 execution の event sample を取得し、新 version でローカル再実行 → 差分(結果・capability call 列)が表示される
  - GREEN: replay 実装(execution log から sample 取得)
  - DoD: replay の比較テスト green

- [ ] **P1-T28**(M)`ext schema diff` + manifest lint
  - RED: hook schema の breaking change(field 削除・型変更)を検出して exit code ≠ 0 / 互換変更(optional 追加)は警告のみ
  - GREEN: semver 互換判定 + CI 組み込み手順
  - DoD: breaking/非 breaking のマトリクステスト green

- [ ] **P1-T29**(S)`ext deploy`
  - RED: deploy → version 登録 → (オプション)installation の段階的切替、が dry-run で検証できる
  - GREEN: deploy コマンド(control-plane API 接続)
  - DoD: dry-run・実 deploy のテスト green

## チャンク I: usage meter(T30–T31)

- [ ] **P1-T30**(M)Analytics Engine 書き込み
  - RED: execution ごとに executions / cpuMs / subrequests / workflowRuns のデータポイントが記録される
  - GREEN: 計測書き込み(課金ではなく adopter 自身の COGS 可視化用)
  - DoD: 書き込みテスト green(AE はローカルでは抽象化し、契約テストで担保)

- [ ] **P1-T31**(S)集計 API
  - RED: tenant/plugin 別の日次集計が取得できる
  - GREEN: 集計エンドポイント
  - DoD: 集計テスト green

## チャンク J: Admin UI 最小(T32–T36)

> UI はコンポーネントテスト(Vitest + Testing Library)+ Playwright E2E。スタイルは admin 用途に徹し、装飾より hierarchy と状態表示を優先する。

- [ ] **P1-T32**(M)UI 基盤
  - GREEN: React + Vite + ルーティング + API クライアント(zod で型共有)+ Playwright 設定
  - DoD: 起動・ログイン(最小トークン認証)・E2E smoke green

- [ ] **P1-T33**(M)installations + permission 画面
  - RED(E2E): install フローで manifest 要求 capability が表示され、grant を確認して有効化できる / config フォームが configSchema から生成され required 検証が効く
  - DoD: E2E + コンポーネントテスト green

- [ ] **P1-T34**(M)versions + rollback 画面
  - RED(E2E): version 履歴表示 → ワンクリック rollback → 確認ダイアログ → 完了表示
  - DoD: E2E green(T07 の drill をこの画面で実施できる)

- [ ] **P1-T35**(M)executions 検索画面
  - RED(E2E): tenant/plugin/hook/status でフィルタし、詳細で capability call 列とエラーを見られる
  - DoD: E2E green

- [ ] **P1-T36**(M)approval queue 画面
  - RED(E2E): manager role に承認待ちが表示され、approve/reject でき、結果が audit に残る
  - DoD: E2E green(P1-T10 の UI 版)

## チャンク K: 品質・ドキュメント・ゲート(T37–T40)

- [ ] **P1-T37**(M)security suite v2
  - 内容: approval 昇格(T12)・budget 回避(T18)・proxy SSRF(T23)・journal 改ざん・UI の CSRF/XSS 検査を統合
  - DoD: `pnpm test:security` green、CI 必須ジョブ

- [ ] **P1-T38**(M)Phase 1 refactor pass
  - 内容: control-plane のモジュール境界見直し、エラー処理の統一、800行超ファイルの分割、依存方向の検査(逆流チェックを CI に追加)
  - DoD: lint/型/テスト green のまま、依存方向チェックが CI に入る

- [ ] **P1-T39**(S)ドキュメント整備
  - 内容: quickstart 2本(proxy mode / SDK 統合)、SDK リファレンス骨子、トラブルシュート(rollback 手順)
  - DoD: 新規参加者がドキュメントだけで E2E デモを再現できる(レビュアー1名で検証)

- [ ] **P1-T40**(S)Phase 1 ゲートレビュー + design partner 開始
  - 内容: Exit Gate 消化、partner 1社へのオンボーディング、フィードバックループ(週次)設定、**Phase 2 タスクの再分割**
  - DoD: Exit Gate 全項目チェック、Phase2.md 最新化
