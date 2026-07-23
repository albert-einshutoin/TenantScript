# Release automation

TenantScriptはChangesetsのversioningとnpm trusted publishingを分離します。release PRはreview可能な
version/CHANGELOG変更だけを作り、registry publishはstable tag・保護environment・GitHub OIDCが揃うまで
起動しません。

## Repository verified

[`release-pr.yml`](../../.github/workflows/release-pr.yml)は`main`のChangesetを検出し、
`chore(release): version packages` PRを作成・更新します。publish commandやnpm credentialは持ちません。

[`release.yml`](../../.github/workflows/release.yml)は`v<major>.<minor>.<patch>` tagで起動し、次を順に
実行します。

1. tag commitが`origin/main`に含まれることを確認する
2. `release:preflight`で8 public packageのfixed version、tag一致、`0.0.0`拒否、Changeset消化を確認する
3. 1.xでは[`v1-launch-readiness.json`](../releases/v1-launch-readiness.json)が`approved`であることを確認する
4. `pnpm verify`と`pnpm pack:check`を再実行する
5. 検証済みtarball由来の`pnpm sbom:generate`を実行する
6. `pnpm changeset publish`をGitHub OIDCで実行する
7. package tagをpushし、SBOM付きGitHub Releaseを作成する

publish jobはGitHub-hosted `ubuntu-latest`、Node 24、npm 11.5.1以上、`id-token: write`、
`npm-publish` environmentを固定します。長期registry tokenをworkflowへ追加してはいけません。
再実行時はChangesetsがregistryの既存versionを判定し、公開済みpackageの二重publishを避けます。

## Accountless preflight

release PRがversionを反映し、Changesetを消化したcheckoutで実行します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm release:preflight -- v1.2.3
```

通常のfeature branchには未消化Changesetがあるため、このcommandが失敗するのは正常です。fixtureとworkflow
境界は`pnpm test:release-automation`でaccountlessに常設検証します。

v1 readiness recordの現在の判定は`blocked`です。production adopter、external contributor、実
advisory対応、独立security review、独立self-host検証、blocker triage、release materialsの公開証拠が
すべて揃ったreview済み変更だけが`approved`になります。0.xはこの外部adoption gateの対象外です。
2.x以降は、1.xの判定を流用せず専用のmajor release gateが必要です。

## External activation checklist

repository実装だけではpublish完了を主張しません。Issue #3のnpm scope確保後、maintainerが次を行います。

1. npm owner全員の2FAと`@tenantscript` scope ownershipを確認する
2. GitHub Actionsにrelease PR作成を許可し、repository variable
   `RELEASE_AUTOMATION_ENABLED=true`を設定する
3. npmの仕様上trusted publisher設定には既存packageが必要なため、8 packageの初回versionを
   clean tarballから対話的2FAでbootstrapする。これはCI token fallbackではなく、一度限りの監査対象作業とする
4. 各packageのtrusted publisherをrepository `albert-einshutoin/TenantScript`、workflow filename
   `release.yml`、environment `npm-publish`、allowed action `npm publish`へ限定する
5. GitHub `npm-publish` environmentへrequired reviewerを設定する
6. protected tag ruleで`v*`作成者をmaintainerへ限定する
7. repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`を最後に設定する
8. release PRをmergeし、main commitへstable tagを作成する
9. 8 packageのversion、provenance、repository link、SBOM付きGitHub ReleaseをregistryとGitHubで確認する
10. traditional automation tokenが存在する場合はrevokeし、npm側でtoken publishを禁止する

初回bootstrap、npm/GitHub設定、registry provenanceのlive証跡がない間は**Repository verified / Blocked**です。
scope未確保のままpackage名を変更したり、workflowへtokenを足して回避してはいけません。

## Failure recovery

- preflight失敗: tagを増やさず、release PR/version/Changesetを修正する
- npm publish途中失敗:同じtag workflowを再実行する。公開済みversionをunpublishしない
- package tag push失敗: npm上のversionを確認してから同じworkflowを再実行する
- GitHub Release作成失敗: npm publishを繰り返し手動実行せず、workflowを再実行してrelease作成まで収束させる
- provenance不在: release完了扱いにせず、trusted publisher filename/environment/OIDC permissionを確認する
