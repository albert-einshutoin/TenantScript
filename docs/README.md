# TenantScript documentation

TenantScriptのドキュメントを、フォルダー構成ではなく「何をしたいか」から選ぶための入口です。
最初に自分の役割を選び、各項目のstatusを確認してから正本へ進んでください。

## Status vocabulary

- **Implemented** — source、設定、または手順がrepositoryに存在します。runtimeでの動作証明を意味しません。
- **Repository verified** — accountless test、E2E、security suite、またはTier 1で継続検証されます。外部環境でのlive deployを意味しません。
- **Live verified** — maintainer管理の外部環境で取得した証跡が、リンク先へ明示的に記録されています。この索引では、証跡のない機能をこのstatusにしません。
- **Blocked** — 実装とは別に、外部account、paid plan、registry、または第三者確認が必要です。

Roadmap and phase plans describe intended work, not available functionality. 現在の実装・repository
証跡・live証跡は[Phase 2 gate evidence](reviews/phase2-gate-evidence.md)で分けて確認できます。

## Adopter / evaluator

TenantScriptが自分のSaaSに合うかを、最小構成と公開証跡から判断する入口です。

- **Repository verified** — [Proxy mode quickstart](quickstarts/zero-integration-proxy-mode.md)で、host改修なしのwebhook変換と安全な転送境界を再現できます。
- **Repository verified** — [SDK integration quickstart](quickstarts/sdk-integration.md)で、typed hook、capability、plugin bundle、dry-run deployを一巡できます。
- **Repository verified / Blocked** — [Phase 2 gate evidence](reviews/phase2-gate-evidence.md)で、repository内の完了証跡と外部運用blockerを区別できます。
- **Blocked** — [Phase 0 benchmark status](benchmarks/phase0.md)で、paid Cloudflare環境が必要なlive benchmarkの未完了範囲を確認できます。

## Plugin author

tenant-scoped pluginを作り、schemaとcapability境界を壊さず検証するための入口です。

- **Repository verified** — [SDK integration quickstart](quickstarts/sdk-integration.md)で、pluginをテストからbundle・dry-runまで実装できます。
- **Repository verified / Blocked** — [Agent-friendly plugin authoring](quickstarts/agent-plugin-authoring.md)で、coding agent向けの最小権限scaffoldとtarball E2Eを再現できます。npmからの取得はscope公開までblockedです。
- **Implemented** — [SDK reference](reference/sdk.md)で、公開TypeScript API、hook context、capabilityの契約を確認できます。
- **Repository verified** — [Schema diff in CI](reference/schema-diff-ci.md)で、breaking change、warning、exit codeをCIへ組み込めます。
- **Repository verified** — [Manifest JSON Schema](reference/manifest-json-schema.md)で、editor・他言語tooling向けのdraft-07構造契約と`parseManifest`のsemantic境界を確認できます。
- **Repository verified** — [Plugin human review checklist](security/plugin-review-checklist.md)で、自動auditでは証明できないsecurity・互換性・運用・docs・licenseを固定commitの証跡でレビューできます。
- **Repository verified / Blocked** — [Plugin review records](security/plugin-reviews/README.md)で、組み込みscaffoldへの5領域レビューと自動失効契約を確認できます。npm registry installと第三者レビューは未検証です。
- **Repository verified / Blocked** — [Community template submission](community/plugin-template-submission.md)で、immutable packet、模擬投稿のbuild/test/audit、人間reviewまでを再現できます。実community投稿と独立reviewは未検証です。
- **Repository verified** — [Template gallery data contract](community/template-gallery-data.md)で、承認済みpacketから生成する最小公開互換カタログとdrift gateを確認できます。
- **Repository verified / Blocked** — [Template gallery](community/template-gallery.md)で、静的catalogの検索・互換情報・accessibility E2Eを確認できます。Workers Assetsへのlive deployと再利用数は未検証です。
- **Repository verified** — [Admin UI performance budget](reference/admin-ui-performance-budget.md)で、300 KiB初期page予算、全JS/CSS予算、更新ルールを確認できます。
- **Repository verified** — [Admin UI 100k execution browser budget](reference/admin-ui-execution-performance.md)で、仮想化DOM上限、初回描画予算、測定境界を確認できます。
- **Repository verified** — [Admin UI accessibility gate](reference/admin-ui-accessibility.md)で、axe zero、keyboard-only主要操作、dialog focus契約、手動検証との境界を確認できます。
- **Repository verified** — [Admin UI visual regression gate](reference/admin-ui-visual-regression.md)で、4 viewport、主要状態、Linux baseline承認、failure artifactの契約を確認できます。
- **Implemented** — [Service token security](security/service-tokens.md)で、自動化tokenのscope・期限・失効境界を確認できます。

## Host developer

既存SaaSへTenantScriptを接続し、app・tenant・database境界を保つための入口です。

- **Repository verified** — [Proxy mode quickstart](quickstarts/zero-integration-proxy-mode.md)で、zero-integration経路のrequest mappingを確認できます。
- **Repository verified** — [SDK integration quickstart](quickstarts/sdk-integration.md)で、host SDKとtyped hookを接続できます。
- **Implemented** — [Public configuration reference](reference/configuration.md)で、Worker bindings、環境変数、defaults、secretの配置先を確認できます。
- **Repository verified** — [App database routing](operations/app-database-routing.md)で、authenticated app単位のD1 routingとfail-closed境界を確認できます。
- **Repository verified** — [OAuth state store](operations/oauth-state-store.md)で、digest-only persistence、browser/app/tenant/actor/redirect binding、一回限り消費を確認できます。
- **Repository verified** — [Slack OAuth callback](operations/slack-oauth-callback.md)で、bounded public HTTP、state-first sequencing、固定redirect、Cookie削除、暗号化token保存、sharded D1 routingを確認できます。
- **Repository verified** — [Slack OAuth install-start](operations/slack-oauth-install-start.md)で、認証済みtenant scope、固定Slack認可URL、`Secure` / `HttpOnly` / `SameSite=None` Cookieを確認できます。
- **Repository verified / Blocked** — [Slack OAuth v2 exchange boundary](operations/slack-oauth-exchange.md)で、固定originのcode交換とcallback Worker compositionを、未取得のcredential-bearing live証跡と区別できます。

## Operator

self-host環境を設定し、失敗を安全に診断・復旧・監査するための入口です。

- **Repository verified** — [Operator troubleshooting index](operations/README.md)で、症状から安全な観測点、正本runbook、禁止操作へ進めます。
- **Implemented** — [Public configuration reference](reference/configuration.md)で、必須bindingと条件付き設定を確認できます。
- **Repository verified** — [Control Plane error catalog](reference/control-plane-errors.md)で、stable code、HTTP status、retryability、client actionを判断できます。
- **Repository verified** — [Control Plane success response schemas](reference/control-plane-success-responses.md)で、全endpointの成功statusと機械可読body契約を確認できます。
- **Repository verified** — [Incident response runbook](operations/incident-response.md)で、検知・封じ込め・復旧・証跡保存を実行できます。
- **Repository verified** — [Rollback troubleshooting](operations/rollback-troubleshooting.md)で、rollbackの診断、結果確認、MTTR drillを実行できます。
- **Repository verified / Blocked** — [Control Plane upgrade guide](operations/control-plane-upgrades.md)で、D1/R2/DOのaccountless保持証跡とcredentialが必要なlive upgradeを分けて確認できます。
- **Implemented** — [Execution retention](operations/execution-retention.md)と[Audit export](operations/audit-export.md)で、保存期間とcompliance exportの責任境界を確認できます。

## Security reviewer

脅威、権限、tenant isolation、報告経路、第三者レビューの証跡を追うための入口です。

- **Implemented** — [Security policy](../SECURITY.md)で、非公開報告先、supported versions、対応SLAを確認できます。
- **Repository verified** — [Threat model](security/threat-model.md)で、trust boundary、攻撃面、mitigation、常設テストを対応付けられます。
- **Blocked** — [Community review packet](security/community-review-packet.md)で、固定commitに対する第三者レビュー範囲と未取得証跡を確認できます。
- **Repository verified** — [RBAC matrix](security/rbac-matrix.md)で、role・scope・tenantごとの許可/拒否境界を確認できます。
- **Repository verified** — [Security suite v3](security/security-suite-v3.md)で、権限昇格攻撃とCI証跡の対応を確認できます。
- **Repository verified** — [Plugin human review checklist](security/plugin-review-checklist.md)で、pluginの固定commit、blocking条件、証跡、非保証を同じ判定語彙で確認できます。
- **Repository verified / Blocked** — [Plugin review records](security/plugin-reviews/README.md)で、固定baselineに対する組み込みscaffoldの自己レビュー証跡を確認できます。独立監査とは扱いません。

## Contributor

安全な変更を小さなPull Requestとして実装し、同じ品質ゲートで検証するための入口です。

- **Repository verified** — [Contributing guide](../CONTRIBUTING.md)で、GitHub Flow、TDD、security checks、PR手順を確認できます。
- **Implemented** — [Good first issues](community/good-first-issues.md)で、境界・実装手順・DoDが明確な入門タスクを選べます。
- **Implemented** — [Phase plan and package boundaries](../tasks/README.md)で、依存方向とplanned scopeを確認できます。計画項目は利用可能機能を意味しません。
- **Implemented** — [Architecture Decision Records](adr/README.md)で、runtime、license、approval、database routingの意思決定を確認できます。
- **Repository verified** — `pnpm verify`で、typecheck、lint、tests、coverage、security suite、dependency audit、formatを一括実行できます。
- **Repository verified** — [Public API stability](reference/public-api-stability.md)で、公開package exportとControl Plane REST route/成功bodyのsnapshot gate、semver判断、更新手順を確認できます。
- **Repository verified / Blocked** — [npm package release contract](reference/npm-package-release.md)で、tarballのaccountless build/install証跡と、npm scope・trusted publishingの外部blockerを区別できます。
- **Repository verified / Blocked** — [Release automation](reference/release-automation.md)で、Changesets release PR、OIDC限定tag publish、初回npm activation手順を確認できます。
- **Implemented** — [Public API stability](reference/public-api-stability.md)で、breaking changeにmajor Changesetとmigration guideを要求するrelease policyを確認できます。
- **Repository verified** — [Release SBOM contract](reference/release-sbom.md)で、実tarball由来のCycloneDX dependency graphとCI artifactを確認できます。
