# TenantScript 1.0 announcement draft

> Publication status: draft. Do not publish this announcement until `v1.0.0` exists and
> `v1-launch-readiness.json` is `approved`.

## TenantScript 1.0: self-hosted extension infrastructure for B2B SaaS

TenantScript 1.0は、B2B SaaSが顧客ごとのplugin、automation、approval、Webhook変換、API policyを
安全に実行するためのApache-2.0 self-hosted control planeです。

host SaaSはtyped hookまたはproxy modeでTenantScriptへ接続します。pluginにはprovider credentialを
直接渡さず、tenant-scoped grant、rate limit、idempotency、auditを持つcapability brokerだけを公開します。
install、version、rollback、approval、execution evidence、usageを、同じ権限境界で追跡できます。

### 1.0で提供するもの

- Host / Plugin SDKとportable manifest v1
- capability brokerとSlack、GitHub、HTTP provider adapter
- Control Plane Worker、Admin UI、CLI、zero-integration proxy quickstart
- encrypted provider secret、OAuth、service token、RBAC、audit chain、execution archive
- self-host setup/doctor/upgrade/recovery documentation
- fork-safe accountless CI、security suite、SBOM、provenance対応release workflow

### Security posture

TenantScriptはuntrusted pluginをtrust boundaryとして扱います。secret exposure、egress bypass、grant
escalation、tenant越境、replay、unsafe cleanupをfail-closed testで継続検証し、脆弱性は
[SECURITY.md](../../SECURITY.md)のprivate reporting processで受け付けます。

CI greenは本番安全性の証明ではありません。公開時には独立security reviewのCRITICAL/HIGHが0件である
こと、実advisory process、Cloudflare live evidence、独立self-host検証をreadiness recordで確認します。

### Self-host and try it

repository checkoutだけで試せる15分quickstartと、production self-host guideを提供します。Cloudflare
credentialを使うlive setupはoperatorがpricing、ownership、rollbackを確認して明示的に実行し、通常の
fork CIへsecretを渡しません。

公開後のinstall commandとversionはGitHub Releaseおよびnpm provenance付きpackageを正本として追記します。
draft段階では未公開package名や成功していないlive deploymentを案内しません。

### Contributing

plugin template、manifest adapter、host integration、security review、documentationのcontributionを歓迎します。
[CONTRIBUTING.md](../../CONTRIBUTING.md)、[good first issues](../community/good-first-issues.md)、
[governance](../../GOVERNANCE.md)を参照してください。利用実績の公開はopt-inだけで行い、匿名feedbackや
security reportをadopter名簿へ転用しません。

### Release verification

このannouncementは次を満たしたreleaseでのみ公開します。

- `v1.0.0` tag、8 packageのnpm publish/provenance、SBOM付きGitHub Release
- clean install、quickstart、self-host setup、rollback drill
- blocker 0のmachine-checked readiness record

未完了条件がある場合はannouncementを公開せず、repositoryをPublic Alpha / Blockedのまま維持します。
