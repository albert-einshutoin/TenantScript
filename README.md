# TenantScript

TenantScriptは、B2B SaaSが顧客ごとのplugin、automation、approval、Webhook変換、API
policyを、安全に実行・監査・version管理するためのCloudflare-nativeなSaaS Extension Control
Planeです。host SaaSへtyped hookまたはproxyを接続し、pluginにはraw credentialではなくtenant-scoped
capabilityだけを渡します。

**Status: Public Alpha — Repository verified.** 公開source、accountless E2E、security suite、package
build、Cloudflare Worker dry-runは継続検証されています。一方、v1.0、npm公開、maintainer環境での
credentialed live運用は未完了です。repositoryの成功を本番稼働実績とは扱いません。

Pure OSS（Apache-2.0）で、運用形態はself-hostです。

## できること

- typed hook、manifest、plugin bundleをversion管理し、tenantごとにinstall・enable・rollbackする
- `slack.send`、`github.issue.create`、`http.fetch`などをgrant、rate limit、audit、idempotency付きの
  broker経由で実行する
- approval、RBAC、service token、execution log、usage、audit chain、retentionをControl Planeで管理する
- host改修を抑えたproxy modeでWebhookをtenant別に変換・転送する
- encrypted provider secret、Slack OAuth、token rotationをplugin/browserへcredentialを渡さず扱う
- Admin UI、CLI、self-host Wrangler template、doctor、upgrade/recovery runbookを利用する

実装済みと計画中の境界は[Audience別ドキュメント入口](docs/README.md)と
[Phase 2 gate evidence](docs/reviews/phase2-gate-evidence.md)で確認できます。

## まず15分で試す

必要なのはNode.js 24、Corepack、pnpm 10.12.1です。Cloudflare account、Slack credential、npm公開packageは
不要です。

```sh
# cwd: repository root
# expected-exit: 0
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @tenantscript/example-saas test -- zero-integration
```

このE2Eは、Stripe形式のWebhookを固定mappingからtenantへ解決し、pluginで変換してallowlisted originへ
転送する一連の契約を再現します。実際のnetwork送信やcredentialは使用しません。設定と期待結果は
[Zero-Integration Proxy Mode Quickstart](docs/quickstarts/zero-integration-proxy-mode.md)にあります。

既存SaaSへtyped hookとplugin SDKを埋め込む場合は
[SDK Integration Quickstart](docs/quickstarts/sdk-integration.md)から始めてください。

## 構成

| Surface              | 役割                                                               | 現在の証跡                         |
| -------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Host / Plugin SDK    | typed hook、manifest、handler、capability context                  | unit + integration tests           |
| Capability broker    | scope、rate limit、journal、audit、provider adapter                | contract + security tests          |
| Control Plane Worker | install、approval、rollback、RBAC、OAuth、usage、audit             | unit + workerd tests               |
| Admin UI             | install review、approval、rollback、execution/audit/connection閲覧 | component + Playwright gates       |
| CLI / self-host      | setup plan、doctor、deploy、migration、rollback                    | accountless E2E + Wrangler dry-run |
| Proxy                | tenant mapping、transform、destination allowlist                   | zero-integration E2E               |

公開TypeScript APIとHTTP contractは
[Public API stability](docs/reference/public-api-stability.md)でsnapshot化され、breaking changeはChangesetsと
migration guideでgateされます。

## 品質と検証境界

変更前の標準gateは次の1コマンドです。

```sh
# cwd: repository root
# expected-exit: 0
pnpm verify
```

`pnpm verify`はtypecheck、lint、全test、coverage、security suite、high以上のdependency audit、formatを
実行します。反復中は`pnpm test:coverage`と`pnpm test:security`を個別に使い、最終確認では全gateへ
戻ってください。

- **Tier 1 (`.github/workflows/tier1.yml`)** — fork-safeなaccountless CI。Cloudflare secretを参照せず、build、package、SBOM、API
  compatibility、browser、security、OSV scanを検証します。
- **Tier 2 Live (`.github/workflows/tier2-live.yml`)** — maintainer管理のcredentialと外部環境が必要なlaneです。現時点ではlive Cloudflare
  deployment、live Slack send/refresh、latency benchmarkの証跡は揃っていません。

securityの設計と報告先は[Threat model](docs/security/threat-model.md)と
[Security policy](SECURITY.md)を参照してください。

## 既知の環境制約

公開前blockerの正本は[Phase 0 gate evidence](docs/reviews/phase0-gate-evidence.md)です。実装済みの
accountless経路と、maintainerだけが取得できるlive evidenceを分けています。

| Blocker                                                                             | Repository内で完了している範囲                    | 残る外部証跡                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [fork-safe CI #2](https://github.com/albert-einshutoin/TenantScript/issues/2)       | Tier 1 workflowとaccountless gates                | maintainer以外のfork PR完走                                                                                                     |
| [npm scope #3](https://github.com/albert-einshutoin/TenantScript/issues/3)          | tarball、SBOM、OIDC publish workflow              | npm `@tenantscript` authentication、scope予約・初回publish・provenance                                                          |
| [Cloudflare runtime #4](https://github.com/albert-einshutoin/TenantScript/issues/4) | workerd testsとWrangler dry-run                   | paid planでのlive deploy・benchmark。詳細は[ADR-001](docs/adr/001-runtime-primitive.md)と[benchmark](docs/benchmarks/phase0.md) |
| [security review #32](https://github.com/albert-einshutoin/TenantScript/issues/32)  | threat model、review packet、fuzz、advisory drill | 独立reviewのCRITICAL/HIGH解消証跡                                                                                               |
| [v1.0 launch #35](https://github.com/albert-einshutoin/TenantScript/issues/35)      | release gatesと公開runbook                        | adopter、external contributor、self-host検証者、release実行                                                                     |

外部credentialや有料planを必要とする作業を、通常のfork開発やローカル検証の前提にはしません。
deployment bundleまでは次のaccountless経路で確認できます。

```sh
# cwd: repository root
# expected-exit: 0
pnpm verify
pnpm --filter @tenantscript/runtime-bench exec wrangler deploy --config wrangler.jsonc --dry-run
```

## ドキュメント

- [Audience別ドキュメント入口](docs/README.md) — adopter、plugin author、host developer、operator、security reviewer、contributor
- [Operator troubleshooting index](docs/operations/README.md) — 症状、安全な観測、復旧runbook、禁止操作
- [SDK reference](docs/reference/sdk.md) — public TypeScript surfaceとcapability境界
- [Canonical glossary](docs/reference/glossary.md) — app、tenant、plugin、installation、capabilityの権限境界
- [Public configuration](docs/reference/configuration.md) — Worker binding、環境変数、default、secret
- [Control Plane errors](docs/reference/control-plane-errors.md) — stable code、retryability、safe client action
- [Production self-host baseline](docs/operations/self-host-production.md) — binding、migration、secret、RBAC、budget、retention
- [CLI reference](docs/reference/cli.md) — command、引数、JSON、exit code
- [Roadmap and package boundaries](tasks/README.md) — Phase 0〜4、TDD、dependency direction
- [Agent onboarding](llms.txt) — coding agent向けの短い索引

## Contributing

[Contributing guide](CONTRIBUTING.md)にGitHub Flow、TDD、security check、PR手順があります。初参加では
[Good first issues](docs/community/good-first-issues.md)から、設計判断は[ADR index](docs/adr/README.md)から
確認してください。community運営は[Governance](GOVERNANCE.md)と
[Code of Conduct](CODE_OF_CONDUCT.md)に従います。

TenantScriptは[Apache License 2.0](LICENSE)で公開されています。
