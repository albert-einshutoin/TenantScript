# Phase 3: v1.0 Production-ready(3〜6ヶ月)

**ゴール:** 第三者が支援なしで self-host し、本番運用できる v1.0 を出す。security・release engineering・ドキュメントを「OSS インフラとして信頼される水準」に引き上げる。

**Exit Gate:**

- [ ] ADOPTERS.md 記載の本番採用 5社以上
- [ ] 外部 contributor の merged PR 10件以上
- [ ] 脆弱性報告への対応プロセスが少なくとも1回実運用されている
- [ ] 外部 security review の指摘(CRITICAL/HIGH)ゼロで v1.0 タグ
- [ ] セットアップガイドのみで self-host 完走(検証者2名)

> タスクは Phase 2 終盤(P2-T24)で再分割する。TDD ワークフローは全タスク共通。

---

## チャンク A: Admin UI 完成(T01–T04)

- [x] **P3-T01**(L→分割)全画面の完成
  - 内容: dashboard(usage / budget / 失敗率)、schema migration tracking、audit ビューア、secret 接続管理
  - DoD: 各画面に E2E + コンポーネントテスト
  - Evidence: Issue #245でtenant/app境界付きの監査read model、署名cursor、raw state非公開schema、Admin UIの監査table・空状態・ページング、component/E2E/security contractを実装。Issue #247でtenant/app境界付きの日次失敗率、budget超過、timeout、egress拒否の運用health endpointとOverview指標を実装。Issue #249でsecret値とsecret参照をSELECT・公開schema・UI parserから除外したprovider接続inventoryとConnections画面を実装。Issue #251 / #253でloginと全主要routeのaxe・keyboard・visual E2EをTier 1へ常設

- [x] **P3-T02**(M)アクセシビリティ
  - RED: axe 自動チェック violation 0 / キーボードのみで全主要フロー(install → grant → rollback → approve)完走の E2E
  - DoD: a11y テストが CI 常設
  - Evidence: Issue #251でloginと全主要routeのunfiltered axe zero、install・capability確認・rollback・approveのkeyboard-only journey、modal focus trap・復帰をTier 1へ常設

- [x] **P3-T03**(M)visual regression
  - 内容: 320 / 768 / 1024 / 1440 のスクリーンショット比較(Playwright)。主要状態(空・ロード・エラー・大量データ)を含む
  - DoD: visual regression が CI 常設、ベースライン承認フロー確立
  - Evidence: Issue #253で320 / 768 / 1024 / 1440の主要8 surface、empty・loading・error・large dataset・confirmation dialog、strict Linux baseline、mobile overflow、failure artifact、承認runbookをTier 1へ常設

- [x] **P3-T04**(S)UI パフォーマンス
  - 内容: 大量 executions(10万行想定)でのページング・仮想化。バンドルサイズ予算(app ページ < 300kb gz)を CI で監視
  - DoD: 予算超過で CI fail
  - Evidence: Issue #241でVite manifest由来の初期page 300 KiB gzip予算と全JS/CSS 450 KiB予算、chunk split回避、closed output検証をTier 1へ常設。Issue #243で10万件synthetic executionの固定高windowing、DOM 32行上限、初回描画1,000ms予算、末尾scrollと詳細操作をChromium/Tier 1へ常設

## チャンク B: secret broker 強化(T05–T07)

- [x] **P3-T05**(M)envelope encryption
  - RED: 保存される token/secret が KMS 相当の鍵で暗号化され、平文が D1/R2/ログのどこにも現れない(全層スキャンテスト)
  - DoD: 暗号化・非露出テスト green
  - Evidence: ADR-005、`packages/control-plane/test/secret-store.test.ts`

- [x] **P3-T06**(M)rotation
  - RED: provider token の rotation 中も capability call が無停止で成功する(新旧鍵の並行受理)
  - DoD: rotation テスト green、手順がドキュメント化
  - Evidence: `provider-token-rotation-store.test.ts`、`provider-token-rotation.test.ts`、`docs/operations/provider-token-rotation.md`

- [x] **P3-T07**(S)provider 接続の汎用化
  - 内容: Slack 以外の OAuth provider を追加するための内部インターフェース安定化(contract test kit 適用)
  - DoD: 2つ目の provider(例: GitHub)が kit を通過
  - Evidence: `createGitHubIssueCreateProvider`、`packages/capabilities/test/capability-contracts.test.ts`、`docs/reference/provider-adapters.md`。Issue #268でSlack OAuth v2のfixed-origin code交換clientを追加し、state/callback/Worker/live compositionはIssue #31に残す

## チャンク C: security 仕上げ(T08–T12)

- [x] **P3-T08**(M)threat model 文書
  - 内容: 信頼境界図、攻撃面の列挙、各 mitigation と対応テストの対応表(security suite と1対1で紐付け)
  - DoD: `docs/security/threat-model.md` 公開。suite に対応漏れの攻撃面がない

- [x] **P3-T09**(S)SECURITY.md + advisory process
  - 内容: 報告窓口、SLA(初回応答・修正目標)、GitHub Security Advisories の運用手順、埋め込み式の謝辞ポリシー
  - DoD: 公開済み。模擬報告で手順を1回リハーサル

- [ ] **P3-T10**(L→分割)外部 security review
  - 資金経路(無予算前提で3経路): (1) OSTIF 等の OSS セキュリティ監査支援プログラムへ応募、(2) Cloudflare の OSS スポンサー経由での支援打診、(3) 確保できない場合は構造化コミュニティレビューにフォールバック(threat model を公開し、攻撃面ごとに ADOPTERS 企業のセキュリティチームへ依頼 + 謝辞掲載)
  - 内容: スコープ定義(loader / broker / egress / RBAC)、指摘のトリアージと修正
  - DoD: いずれかの経路でレビューが実施され、CRITICAL/HIGH ゼロ。指摘→修正→regression テスト追加まで完了

- [x] **P3-T11**(M)fuzzing
  - RED: manifest パーサ・hook payload・config への fuzz(構造化 fuzz)でクラッシュ・hang・カタストロフィック backtracking ゼロ
  - DoD: fuzz ジョブが nightly CI に常設

- [ ] **P3-T12**(M)supply chain
  - 内容: 依存固定(lockfile 監査)、SBOM 生成、npm provenance 付き publish、Renovate/Dependabot 運用ルール
  - DoD: publish パイプラインで SBOM/provenance が自動生成
  - Progress: Issue #225で公開8 packageのclosed tarball、public provenance metadata、credential-free clean install smokeを実装。Issue #229で実tarball由来のreproducible CycloneDX SBOMとTier 1 artifactを実装。trusted publishing実行、registry provenance確認は未完了

## チャンク D: release engineering(T13–T16)

- [ ] **P3-T13**(M)changesets + 自動 publish
  - RED: changeset なしの破壊的変更 PR が CI で fail する
  - DoD: タグ → npm publish → GitHub Release が自動化
  - Progress: Issue #225でsource-only topological build、pack budget、全export/bin import smokeをTier 1へ常設。Issue #227でfixed-version Changesetsとbreaking API release policyをTier 1へ常設。Issue #237でChangesets release PRとmain-ancestry/stable-tag preflight、OIDC限定npm publish、SBOM付きGitHub Release workflowを実装。npm scope/初回bootstrap/trusted publisher/provenance live確認は外部blocker

- [ ] **P3-T14**(M)API freeze + semver ポリシー
  - 内容: 公開 API(SDK / manifest / control-plane REST)の表面を明文化し、breaking change 検知を CI 化(`ext schema diff` の自プロダクト適用)
  - DoD: API surface スナップショットテスト常設
  - Progress: Issue #223で公開package symbol/subpathとControl Plane REST route/method/isolationのsnapshot gateを実装。Issue #227で削除/kind/REST互換性破壊をmajor Changesetとmigration guideへ機械的に連携。Issue #233でparser同源の公開manifest draft-07 JSON Schemaと構造snapshotを実装。Issue #235で成功status/body schema、実handler検証、release policy連携を実装。Issue #247時点で全18 endpoint・19 methodを公開契約として固定

- [x] **P3-T15**(M)upgrade guide + migration テスト
  - RED: 「前 minor → 最新」のアップグレードが、データ(D1/R2/DO)を保持したまま通る自動テスト
  - DoD: upgrade テストが CI 常設、ガイド公開
  - Progress: Issue #231で、未公開minorを装わないimmutable `pre-v1-0010` baselineから現行へのworkerd upgrade journeyを常設。D1/R2/DO保持、suffix再適用、失敗migration rollback、現行schema利用とoperator guideをTier 1で検証

- [ ] **P3-T16**(S)performance regression CI(**Tier 2**: 実 Cloudflare、nightly)
  - 内容: Phase 0 ベンチハーネスを CI 化し、p95 warm の劣化(>20%)で fail
  - DoD: Tier 2 nightly で実行、ダッシュボード化

## チャンク E: self-host & docs(T17–T20)

- [ ] **P3-T17**(M)`ext setup`(セットアップウィザード)
  - RED: クリーンな Cloudflare アカウントに対し、D1/R2/DO/Workflows/AE の作成と初期 migration が一括で通る(dry-run は Tier 1、実アカウント E2E は **Tier 2**)
  - DoD: 新規アカウントでの setup E2E green(Tier 2)
  - Progress: accountless production dry-run plannerをIssue #183、最小WranglerをIssue #185、resumable run journalとownership-safe cleanupをIssue #187、fixed-origin Cloudflare API transportをIssue #189、ownership-aware D1 create/adopt/cleanup adapterをIssue #191、exact operation ID provider routerをIssue #193、pinned catalogとresumable D1 migration adapterをIssue #195、artifact/execution archiveのownership-safe R2 adapterをIssue #197、fail-closed Wrangler D1 migration runnerをIssue #199、mutation前のprovider route coverage preflightをIssue #201、strict pinned Wrangler Worker deploy processをIssue #203、Control Plane Workerのcreate/adopt ownershipとcleanup順のplan契約をIssue #205、closed initial/resume reconcile contextをIssue #207、deploy/cleanup共有の決定論的Worker target契約をIssue #209、atomic marker付きremote Worker ownership adapterをIssue #213、Durable Object lifecycleのWorker deploy集約とdeclarative `exports`移行をIssue #215、R2 adapter/renderer/cleanup共有の決定論的target契約をIssue #217、Analytics Engine binding lifecycleとD1 usage summaryのproduction compositionをIssue #264、encrypted provider secret-storeのtenant-isolated DO adapterとWorker-owned lifecycleをIssue #266で実装。remaining resource adapter、provider-facing OAuth/key provisioning、CLI live composition、execution-recording caller、clean-account Tier 2はIssue #34に残す

- [ ] **P3-T18**(S)`ext doctor`(自己診断)
  - RED: binding 欠落・migration 未適用・権限不足を検知して人間が読める修復手順を出す
  - DoD: 故障注入テスト green
  - Progress: `ext doctor --report`のclosed offline evaluatorと故障注入testをIssue #181で実装。live Cloudflare collectorとclean-account検証はIssue #34に残す

- [ ] **P3-T19**(M)self-host ガイド + IaC テンプレ
  - 内容: wrangler 設定テンプレ、本番チェックリスト(budget / retention / RBAC 初期値)
  - DoD: 検証者2名がガイドのみで self-host 完走(Exit Gate 連動)
  - Progress: Issue #185で`cloudflare-workers`向けのfail-closed最小Wrangler生成と本番チェックリストを実装。未結線resource、live apply、検証者2名の完走はIssue #34に残す

- [ ] **P3-T20**(M)agent-friendly docs(D-016)
  - 内容: llms.txt、plugin scaffold テンプレ集、チュートリアルのコード断片を CI でテスト(docs が腐らない仕組み)
  - DoD: coding agent(Claude Code 等)に「pluginを書いて」と指示して、docs だけで manifest 込みの動く plugin が生成されることを実地検証
  - Progress: Issue #239でCLI versionと一致するexact SDK dependencies、最小権限test、実tarballに対するfresh scaffold build/test、agent authoring guideとdocs contractを実装。外部coding agent製品による独立evalは未完了

## チャンク F: v1.0 リリース(T21–T22)

- [ ] **P3-T21**(S)v1.0 リリースチェックリスト
  - 内容: Exit Gate 全消化、既知 issue のトリアージ(v1.0 blocker ゼロ)、CHANGELOG、announcement 文面
  - DoD: チェックリスト完了、v1.0.0 タグ

- [ ] **P3-T22**(S)Phase 3 ゲートレビュー
  - 内容: リリース後レビュー(振り返り)、**Phase 4 タスクの再分割**
  - DoD: Phase4.md 最新化
