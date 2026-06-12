# Phase 0: Prototype(2〜4週)

**ゴール:** Cloudflare 上で tenant plugin を「安全に」実行できることを、テストとベンチで証明する。

**Exit Gate(プロダクトドキュメント §12 準拠):**

- [ ] E2E デモ成立: example-saas の `invoice.created` → installed plugin → モック Slack 通知
- [ ] blocking hook(transform)の p95 added latency が warm < 50ms(実測値を docs/benchmarks/ に記録)
- [ ] adversarial security suite green(raw secret 露出・egress 逸脱・grant 外 capability の既知経路ゼロ)
- [ ] ADR-001 確定: Dynamic Worker Loader vs Workers for Platforms の選定
- [ ] 全 package カバレッジ 80%+、CI green

**スコープ外(Phase 1 に送る):** approval、rollback、budget cap、proxy mode、CLI、Admin UI、実 Slack OAuth。

---

## チャンク A: 基盤(T01–T04)

- [ ] **P0-T01**(M)monorepo scaffold
  - RED: 各 package の placeholder テスト(`expect(true)`ではなく、共有 tsconfig の strict 設定を検証する設定テスト)が `pnpm -r test` で実行されることを先に確認
  - GREEN: pnpm workspaces、`packages/{manifest,plugin-sdk,host-sdk,loader,capabilities,control-plane}` と `apps/example-saas` の骨組み、共有 tsconfig(strict)、Vitest、ESLint + Prettier
  - DoD: `pnpm -r typecheck && pnpm -r lint && pnpm -r test` が green

- [ ] **P0-T02**(S)CI パイプライン
  - RED: わざと型エラーを入れた PR で CI が fail することを確認(その後 revert)
  - GREEN: GitHub Actions で typecheck → lint → test → coverage(80% gate)
  - DoD: main への push と PR で CI が走り、coverage 閾値違反で fail する

- [ ] **P0-T03**(M)vitest-pool-workers セットアップ
  - RED: workerd 内で D1 に insert → select する smoke テストを先に書く(fail を確認)
  - GREEN: `@cloudflare/vitest-pool-workers` 設定、テスト用 wrangler config(D1 / R2 / DO バインディング)
  - DoD: integration テストが workerd 内で実行され、D1/R2/DO に触れる

- [ ] **P0-T04**(S)ADR 運用開始
  - GREEN: `docs/adr/` を作成し、ADR-000(TypeScript 選定、D-017 の実装版)を記録。テンプレートを置く
  - DoD: ADR テンプレと ADR-000 がコミットされている

## チャンク B: manifest package(T05–T08)

- [ ] **P0-T05**(M)ManifestSchema(Zod)
  - RED: valid manifest 1種 + invalid fixtures 8種以上(不正 semver range / capability キー形式違反 / cpuMs 負数 / timeoutMs 欠落 / egress mode 不正 / hooks 空 / 未知トップレベルキー / version 形式違反)のパース結果テスト
  - GREEN: `parseManifest()` を実装。エラーは人間が読めるパス付きメッセージ
  - DoD: fixtures 全 green、カバレッジ 90%+(このパッケージは検証の要なので高め)

- [ ] **P0-T06**(M)configSchema 検証
  - RED: required 欠落で install 検証が落ちる / default が補完される / 型不一致が拒否される、の3系統
  - GREEN: `validateConfig(manifest.configSchema, config)` を実装(D-013)
  - DoD: 正常・異常・default 補完のテスト green

- [ ] **P0-T07**(S)$config.* 参照解決
  - RED: grant 内 `$config.notifyChannel` が installation config の実値に解決される / 未定義参照はエラー
  - GREEN: `resolveGrants(manifest.capabilities, config)` を実装
  - DoD: 解決後の grant が具体値のみになることをテストで保証

- [ ] **P0-T08**(S)チャンク B refactor + 堅牢化
  - RED: fast-check による property-based テスト(ランダム入力でパーサが throw ではなく構造化エラーを返す)
  - GREEN: 発見された境界バグの修正、重複排除
  - DoD: property テスト 1000 ケース green、lint/型/テスト green のまま

## チャンク C: SDK(T09–T13)

- [ ] **P0-T09**(M)host-sdk: defineHooks
  - RED: event/transform/policy の型ごとの default failure policy(fail-open / skip / deny)が設定される / 未知 hook 型が拒否される / budgetMs 必須条件(blocking のみ)
  - GREEN: `defineHooks()` 実装(D-012)
  - DoD: 3 hook 型の宣言テスト green、型レベルでも誤用がコンパイルエラーになる(type-level test)

- [ ] **P0-T10**(S)host-sdk: payload schema 検証
  - RED: schema 違反 payload で `extensions.run()` が HookPayloadError を返し、plugin が実行されないこと
  - GREEN: run() 冒頭での Zod 検証
  - DoD: 正常 / 違反 / 欠落フィールドのテスト green

- [ ] **P0-T11**(M)host-sdk: 実行計画(in-memory)
  - RED: 複数 installation で event は並列(順序非保証)・transform/policy は priority 順直列になる / disabled installation が除外される / transform チェーンで前段出力が後段入力になる
  - GREEN: in-memory installation store + `planExecution()` 実装
  - DoD: 並列・直列・優先度・除外の4系統テスト green

- [ ] **P0-T12**(M)plugin-sdk: definePlugin
  - RED: 宣言した handler が登録される / manifest の hooks に無い handler 呼び出しはエラー / handler 例外が構造化エラーとして伝播する
  - GREEN: `definePlugin()` と handler dispatch 実装
  - DoD: 正常 dispatch・未知 hook・例外伝播のテスト green

- [ ] **P0-T13**(S)戻り値契約
  - RED: transform は payload 返却必須(返さなければ契約違反エラー)/ policy は `allow | deny | modify` の union 以外を拒否 / event は戻り値無視
  - GREEN: hook 型ごとの戻り値バリデータ
  - DoD: 3 hook 型 × 正常/違反のテスト green

## チャンク D: loader / sandbox(T14–T18)

- [ ] **P0-T14**(L→分割可)runtime 比較スパイク(timebox: 2日)
  - 内容: Worker Loader API(Dynamic Workers)と Workers for Platforms dispatch namespace で同じ最小 plugin を動かし、cold/warm latency・limits 設定・egress 制御・ローカル開発体験を比較
  - DoD: **ADR-001** に実測値と選定理由を記録(以降のタスクは選定した方式で進める)。プロダクトドキュメント §15 Open Questions の該当行を解消としてマーク

- [ ] **P0-T15**(M)plugin bundle + version hash
  - RED: 同一入力 → 同一 hash(決定論性)/ 内容変更で hash 変化 / 外部 import の解決
  - GREEN: esbuild バンドラ + SHA-256 content hash
  - DoD: 決定論テスト green(タイムスタンプ等の非決定要素を排除)

- [ ] **P0-T16**(M)isolate 実行 + scoped bindings のみ注入
  - RED(攻撃テスト): plugin コードから `process.env` / グローバル binding / 他 plugin の名前空間が見えないことを先にテスト
  - GREEN: 選定 runtime で plugin module をロードし、ctx 経由の値のみ渡す
  - DoD: 露出試行テスト全 green(= 全攻撃失敗)

- [ ] **P0-T17**(M)limits enforcement
  - RED: 無限ループ plugin が timeoutMs で強制終了し、execution に `timeout` が記録される / subrequest 上限超過が拒否される
  - GREEN: limits 設定の適用(選定 runtime の custom limits / loader 側ガード)
  - DoD: timeout・subrequest 上限のテスト green

- [ ] **P0-T18**(M)egress deny-by-default
  - RED(攻撃テスト): plugin 内の `fetch()` が失敗し、execution log に `egress_denied` が記録される / リダイレクトや DNS 回し等の迂回も塞がる(既知パターンを列挙)
  - GREEN: globalOutbound 遮断(D-005)
  - DoD: 迂回パターン含む全攻撃テスト green

## チャンク E: capability broker + control plane 最小(T19–T23)

- [ ] **P0-T19**(M)capability 呼び出しブリッジ
  - RED: grant 済み capability は通る / 未 grant は CapabilityDeniedError / 引数が grant の scope(channel 制限等)で検証される
  - GREEN: isolate → broker の RPC 契約 + grant 照合
  - DoD: 許可・拒否・scope 違反の3系統 green

- [ ] **P0-T20**(M)slack.send capability(モック)
  - RED(攻撃テスト含む): grant 外 channel への送信拒否 / raw token が plugin 側のスコープに存在しない(ctx を deep-inspect するテスト)/ モック Slack サーバへ正しい payload が届く
  - GREEN: broker 側で token を保持し、plugin には結果のみ返す(D-004)
  - DoD: 機能テスト + 露出テスト green

- [ ] **P0-T21**(M)D1 schema v1 + migrations
  - RED: migration 適用後に apps / tenants / plugins / plugin_versions / installations / executions の CRUD smoke が通る(workerd 内)
  - GREEN: スキーマ定義 + wrangler migrations
  - DoD: integration テスト green、migration はべき等

- [ ] **P0-T22**(S)R2 artifact store
  - RED: put → get by hash の round-trip / **同一 hash への上書きが拒否される**(immutability)
  - GREEN: artifact put/get + immutable ガード
  - DoD: round-trip・immutability テスト green

- [ ] **P0-T23**(M)execution log 書き込み / 検索
  - RED: 実行ごとに status / duration / error / capabilityCalls / version が保存される / tenant・plugin・hook で検索できる
  - GREEN: execution 記録 + 検索 API(最小)
  - DoD: 書き込み・検索テスト green

## チャンク F: E2E・検証・品質(T24–T28)

- [ ] **P0-T24**(M)E2E: example-saas デモ
  - RED: 「invoice.created 発火 → installation 解決 → plugin 実行 → モック Slack 受信 → execution log 記録」を 1 本の E2E テストとして先に書く
  - GREEN: example-saas(最小 host app)+ サンプル plugin(large-invoice-notify)を接続
  - DoD: E2E green。手動デモ手順を `apps/example-saas/README.md` に記載

- [ ] **P0-T25**(M)レイテンシベンチ
  - 内容: transform hook(webhook.outbound)1段の added latency を warm/cold で計測するハーネス
  - DoD: p95 warm < 50ms / cold < 300ms の実測を `docs/benchmarks/phase0.md` に記録。未達なら原因分析を issue 化(gate 判断材料)

- [ ] **P0-T26**(M)adversarial security suite v1(常設化)
  - 内容: T16/T18/T20 の攻撃テストを `security-suite` として独立実行可能に集約し、CI の必須ジョブにする。追加攻撃: 他 tenant の installation/config/log への越境参照
  - DoD: `pnpm test:security` が CI 必須ジョブとして green

- [ ] **P0-T27**(S)Phase 0 refactor pass
  - 内容: パッケージ境界・命名・重複の見直し(コードレビュー込み)。800行超ファイル・50行超関数の分割
  - DoD: lint/型/テスト green のまま完了。レビュー指摘の CRITICAL/HIGH ゼロ

- [ ] **P0-T28**(S)Phase 0 ゲートレビュー
  - 内容: Exit Gate チェックリスト消化、ADR-001 確定、ベンチ結果レビュー、**Phase 1 タスクの再分割**(ローリングウェーブ)
  - DoD: Exit Gate 全項目にチェック。Phase1.md が最新化されている
