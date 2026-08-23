# Changelog

TenantScriptの公開releaseに含まれる主要変更を記録します。packageごとの機械的なversion変更は
Changesetsが生成し、このファイルは導入・migration・security・既知制約をまとめます。

## [1.0.0] - Unreleased

この節は公開前draftです。`v1.0.0` tag、npm package、GitHub Releaseはまだ存在せず、
[v1 launch readiness](docs/releases/v1-launch-readiness.json)が`approved`になるまで公開しません。

### Added

- `@tenantscript/host-sdk` / `@tenantscript/plugin-sdk`: typed hook、plugin handler、capability
  context、continuation hookの公開契約。
- `@tenantscript/manifest`: closed manifest schema、capability最小権限、portable conformance
  corpusと独立adapter検証。
- `@tenantscript/capabilities`: tenant-scoped capability broker、rate limit、idempotency、audit、
  Slack/GitHub/HTTP/provider adapter、approval request lifecycle。
- `@tenantscript/control-plane`: install、enable、rollback、approval、RBAC、service token、audit
  chain、execution archive、usage meter、Slack OAuthとencrypted provider secretのaccountless契約。
- `@tenantscript/loader`: artifact integrity検証、workerd sandbox、Dynamic Worker caller、timeout、
  capability drain、execution/usage evidence。
- `@tenantscript/proxy`: tenant mapping、allowlisted destination、Webhook transformを行う
  zero-integration proxy mode。
- `@tenantscript/cli`: scaffold、build、audit、deploy dry-run、setup plan、doctor、migration、
  ownership-safe cleanup journal、Admin操作。
- Admin UI、example SaaS、template gallery、plugin authoring judge/eval、fork-safe Tier 1、SBOM、
  Changesets/OIDC release workflow。

### Security

- pluginへraw credentialを渡さず、grantされたcapabilityだけを公開します。
- secret exposure、egress bypass、grant escalation、tenant境界、OAuth replay、cleanup ownershipを
  permanent security suiteでfail-closed検証します。
- security報告は[SECURITY.md](SECURITY.md)、設計境界は
  [threat model](docs/security/threat-model.md)を正本とします。
- repository/accountless検証は、独立security reviewやcredentialed live platform検証の代替では
  ありません。

### Migration notes

- Node.js 24、Corepack、pnpm 10.12.1を使用し、`pnpm install --frozen-lockfile`で導入します。
- self-host更新前に[upgrade runbook](docs/operations/control-plane-upgrades.md)でmigration順序、backup、rollback、
  compatibilityを確認してください。
- Control Plane D1 migrationはpinned manifestとexact-prefix remote historyを検証し、未適用suffixだけを
  適用します。履歴を書き換えたりdown migrationを自動実行したりしません。
- public TypeScript / HTTP contractの互換性は
  [public API stability policy](docs/reference/public-api-stability.md)に従います。

### Breaking changes

- 公開済みstable versionに対するbreaking changeはありません。1.0.0が最初のstable候補です。
- alpha checkout利用者は固定commitから更新し、release前に上記upgrade runbookとgenerated
  configuration差分を確認してください。

### Known limitations

- npm `@tenantscript` scope、初回publish、trusted publishing、provenanceのlive証跡は未完了です。
- Cloudflare paid planでのruntime benchmark、credentialed Tier 2、provider billing cost、20% performance
  baselineは未完了です。
- 独立fork CI、production adopter、external contributor、実advisory response、独立security review、
  2名のguide-only self-host検証は未完了です。
- full credential-bearing `ext setup`、Approval Workflow/runtime Workerのproduction composition、live
  secret/OAuth rotationは未完了です。
- 最新状態と公開可否は[readiness record](docs/releases/v1-launch-readiness.json)を確認してください。
