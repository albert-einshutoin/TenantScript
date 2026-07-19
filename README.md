# TenantScript

Cloudflare-native SaaS Extension Control Plane — B2B SaaSが顧客ごとのコード・自動化・承認フロー・Webhook変換・API policyを、安全に、監査可能に、version管理された形で実行できるようにするためのOSSプロジェクト(計画段階)。

Cloudflare Dynamic Workers / Workers for Platforms / Workflowsをkernelとして使い、その上のControl Plane(manifest、permission、versioning、rollback、execution logs、approval)を提供する。

## ドキュメント

- [Proxy mode quickstart](docs/quickstarts/zero-integration-proxy-mode.md) — host改修なしでwebhook変換を15分で再現
- [SDK integration quickstart](docs/quickstarts/sdk-integration.md) — typed hook、plugin、capability、dry-run deployをTDDで接続
- [SDK reference](docs/reference/sdk.md) — Phase 1 public TypeScript surfaceと安全境界
- [Schema diff in CI](docs/reference/schema-diff-ci.md) — breaking判定、exit code、warning、CI統合
- [Rollback troubleshooting](docs/operations/rollback-troubleshooting.md) — 検知、復旧、実行確認、MTTR drill
- [Contributing](CONTRIBUTING.md) — 開発環境、TDD、security、issue・PRレビュー手順
- [Governance](GOVERNANCE.md) — maintainer責任、ADR意思決定、co-maintainerへの経路
- [プロダクト戦略 & MVP仕様](docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) — v0.4 Working Draft
- [開発プラン & フェーズ別タスク](tasks/README.md) — TDDベースのPhase 0〜4タスク分解(言語: TypeScript、D-017)
- [ベンチマーク証跡](docs/benchmarks/README.md) — Phase 0 runtime latency と Phase 1 rollback drill
- [Admin変更APIのrate limit運用](docs/operations/admin-mutation-rate-limits.md) — Durable Object binding、fail-closed方針、設定範囲
- [Admin installの冪等再試行](docs/operations/admin-install-idempotency.md) — Idempotency-Key、409、D1原子性、保存期間
- [Admin rollbackの結果復旧](docs/operations/admin-rollback-idempotency.md) — 応答喪失、revision CAS、audit result再取得
- [Security suite v2 threat map](docs/security/security-suite-v2.md) — Phase 1攻撃面、常設テスト、依存境界CI
- [Security policy](SECURITY.md) — supported versions、非公開の脆弱性報告窓口、対応SLA
- [Usage meter運用契約](docs/operations/usage-meter.md) — Analytics Engine固定schema、fail-open、UTC期間集計

## ローカル検証とCI

コントリビューターがPull Requestを送る前に実行する標準の品質ゲートは `pnpm verify` です。型検査、lint、通常テスト、カバレッジ、セキュリティスイート、high以上の依存関係監査、format確認を決定的な順序で実行します。Cloudflareアカウントや資格情報を使わないaccountlessな検証です。

```sh
# cwd: repository root
# expected-exit: 0
pnpm install --frozen-lockfile
pnpm verify
```

調査中に対象を絞る場合は、カバレッジ閾値を確認する `pnpm test:coverage` と、tenant境界・権限昇格・egressなどを確認する `pnpm test:security` を個別に実行できます。最終確認では個別コマンドの代わりに `pnpm verify` を実行してください。

- **Tier 1 (`.github/workflows/tier1.yml`)**: forkのPull Requestと `main` へのpushで動くaccountless quality gateです。Cloudflare secretsを参照せず、固定バージョンのOSV Scannerを含むため、外部コントリビューターも同じ品質境界で検証できます。
- **Tier 2 Live (`.github/workflows/tier2-live.yml`)**: maintainer管理のscheduleまたは手動実行に限定したlive検証レーンです。Cloudflareアカウント、資格情報、paid planを必要とするsmoke testやlatency benchmarkはこのレーンだけに追加し、fork-safeな検証をTier 1から移動しません。現在のlive smokeはplaceholderであり、資格情報を伴う実行は未構成です。

## 方針

- **Pure OSS**: 収益化を目的としない。self-hostが唯一の運用形態(ドキュメント D-008)。
- **Markdownがsource of truth**: docx等が必要な場合は都度mdからエクスポートする(例: pandoc)。
- **GitHub Flow**: `main` を唯一の長期ブランチとし、作業は短命の `feature/*` ブランチから Pull Request で統合する。`develop` / `release/*` / `hotfix/*` は使わない。
- **ステータス**: Phase 0 の中核実装はほぼ完了し、Phase 0 Exit Gate の証跡回収中。Phase 1 MVP は control-plane / rollback / approval / budget / proxy / CLI / usage meter / Admin UI / security suite v2と導入ドキュメントまで実装済みで、partner onboarding・refactor pass・Phase 1 gate reviewが未完了。

## 現在のブロッカー

- [#2](https://github.com/albert-einshutoin/TenantScript/issues/2): fork PR で Tier 1(accountless) が完走することの検証
- [#3](https://github.com/albert-einshutoin/TenantScript/issues/3): npm `@tenantscript` scope の確保
- [#4](https://github.com/albert-einshutoin/TenantScript/issues/4): Cloudflare paid Workers account での live runtime benchmark
