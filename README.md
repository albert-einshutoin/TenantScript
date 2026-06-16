# TenantScript

Cloudflare-native SaaS Extension Control Plane — B2B SaaSが顧客ごとのコード・自動化・承認フロー・Webhook変換・API policyを、安全に、監査可能に、version管理された形で実行できるようにするためのOSSプロジェクト(計画段階)。

Cloudflare Dynamic Workers / Workers for Platforms / Workflowsをkernelとして使い、その上のControl Plane(manifest、permission、versioning、rollback、execution logs、approval)を提供する。

## ドキュメント

- [プロダクト戦略 & MVP仕様](docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) — v0.4 Working Draft
- [開発プラン & フェーズ別タスク](tasks/README.md) — TDDベースのPhase 0〜4タスク分解(言語: TypeScript、D-017)

## 方針

- **Pure OSS**: 収益化を目的としない。self-hostが唯一の運用形態(ドキュメント D-008)。
- **Markdownがsource of truth**: docx等が必要な場合は都度mdからエクスポートする(例: pandoc)。
- **ステータス**: Phase 0 の中核実装はほぼ完了し、Phase 0 Exit Gate の証跡回収中。Phase 1 MVP は control-plane / rollback / approval / budget / proxy / CLI / usage meter まで着手済みで、Admin UI・partner onboarding・security suite v2・ドキュメント整備・Phase 1 gate review が未完了。

## 現在のブロッカー

- [#2](https://github.com/albert-einshutoin/TenantScript/issues/2): fork PR で Tier 1(accountless) が完走することの検証
- [#3](https://github.com/albert-einshutoin/TenantScript/issues/3): npm `@tenantscript` scope の確保
- [#4](https://github.com/albert-einshutoin/TenantScript/issues/4): Cloudflare paid Workers account での live runtime benchmark
