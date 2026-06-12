# TenantScript

Cloudflare-native SaaS Extension Control Plane — B2B SaaSが顧客ごとのコード・自動化・承認フロー・Webhook変換・API policyを、安全に、監査可能に、version管理された形で実行できるようにするためのOSSプロジェクト(計画段階)。

Cloudflare Dynamic Workers / Workers for Platforms / Workflowsをkernelとして使い、その上のControl Plane(manifest、permission、versioning、rollback、execution logs、approval)を提供する。

## ドキュメント

- [プロダクト戦略 & MVP仕様](docs/Cloudflare-native_SaaS_Extension_Control_Plane_Product_Document.md) — v0.3 Working Draft

## 方針

- **Pure OSS**: 収益化を目的としない。self-hostが唯一の運用形態(ドキュメント D-008)。
- **Markdownがsource of truth**: docx等が必要な場合は都度mdからエクスポートする(例: pandoc)。
- **ステータス**: Phase 0(Prototype)前。次のアクションはドキュメントの「15. Open Questions」を参照。
