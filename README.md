# TenantScript

Cloudflare-native SaaS Extension Control Plane — B2B SaaSが顧客ごとのコード・自動化・承認フロー・Webhook変換・API policyを、安全に、監査可能に、version管理された形で実行できるようにするためのOSSプロジェクト(計画段階)。

Cloudflare Dynamic Workers / Workers for Platforms / Workflowsをkernelとして使い、その上のControl Plane(manifest、permission、versioning、rollback、execution logs、approval)を提供する。

## ドキュメント

- [Proxy mode quickstart](docs/quickstarts/zero-integration-proxy-mode.md) — host改修なしでwebhook変換を15分で再現
- [SDK integration quickstart](docs/quickstarts/sdk-integration.md) — typed hook、plugin、capability、dry-run deployをTDDで接続
- [SDK reference](docs/reference/sdk.md) — Phase 1 public TypeScript surfaceと安全境界
- [Rollback troubleshooting](docs/operations/rollback-troubleshooting.md) — 検知、復旧、実行確認、MTTR drill
- [プロダクト戦略 & MVP仕様](docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) — v0.4 Working Draft
- [開発プラン & フェーズ別タスク](tasks/README.md) — TDDベースのPhase 0〜4タスク分解(言語: TypeScript、D-017)
- [ベンチマーク証跡](docs/benchmarks/README.md) — Phase 0 runtime latency と Phase 1 rollback drill
- [Admin変更APIのrate limit運用](docs/operations/admin-mutation-rate-limits.md) — Durable Object binding、fail-closed方針、設定範囲
- [Admin installの冪等再試行](docs/operations/admin-install-idempotency.md) — Idempotency-Key、409、D1原子性、保存期間
- [Admin rollbackの結果復旧](docs/operations/admin-rollback-idempotency.md) — 応答喪失、revision CAS、audit result再取得
- [Security suite v2 threat map](docs/security/security-suite-v2.md) — Phase 1攻撃面、常設テスト、依存境界CI
- [Security policy](SECURITY.md) — supported versions、非公開の脆弱性報告窓口、対応SLA
- [Usage meter運用契約](docs/operations/usage-meter.md) — Analytics Engine固定schema、fail-open、UTC期間集計

## 方針

- **Pure OSS**: 収益化を目的としない。self-hostが唯一の運用形態(ドキュメント D-008)。
- **Markdownがsource of truth**: docx等が必要な場合は都度mdからエクスポートする(例: pandoc)。
- **GitHub Flow**: `main` を唯一の長期ブランチとし、作業は短命の `feature/*` ブランチから Pull Request で統合する。`develop` / `release/*` / `hotfix/*` は使わない。
- **ステータス**: Phase 0 の中核実装はほぼ完了し、Phase 0 Exit Gate の証跡回収中。Phase 1 MVP は control-plane / rollback / approval / budget / proxy / CLI / usage meter / Admin UI / security suite v2と導入ドキュメントまで実装済みで、partner onboarding・refactor pass・Phase 1 gate reviewが未完了。

## 現在のブロッカー

- [#2](https://github.com/albert-einshutoin/TenantScript/issues/2): fork PR で Tier 1(accountless) が完走することの検証
- [#3](https://github.com/albert-einshutoin/TenantScript/issues/3): npm `@tenantscript` scope の確保
- [#4](https://github.com/albert-einshutoin/TenantScript/issues/4): Cloudflare paid Workers account での live runtime benchmark
