# Plugin authoring judge image publication

このrunbookは、machine-checked candidate evidenceを持つdefault branch上の固定commitからjudge imageを
GHCRへ公開し、registry digestとGitHub artifact attestationを取得するmaintainer向け手順です。
repositoryへworkflowが存在するだけでは公開済みを意味しません。成功した`workflow_dispatch`のreceiptを
取得し、digestとattestationを別々に確認するまでrunner requestへ設定しません。

## 1. Publish対象を固定する

対象commitは40文字のlowercase SHAで、dispatch時点の`main` headおよびworkflowの`github.sha`と一致する必要があります。candidate review recordの
checkerが現在のDockerfile、lockfile、allowlisted contextとreview evidenceの一致を確認します。PR head、branch名、
tag、過去commit、`latest`は入力にしません。この同一性によりreceiptのsource revisionとattestationのsource digestを
別revisionへ分岐させません。過去の公開済みimageは再buildせず、既存のimmutable digestを使用します。

```sh
# cwd: repository root
# expected-exit: 0
git fetch origin main --no-tags
SOURCE_REVISION="$(git rev-parse origin/main)"
git merge-base --is-ancestor "$SOURCE_REVISION" origin/main
```

Actionsの **Publish plugin authoring judge image** を開き、`workflow_dispatch`の
`source_revision`へ固定SHAを入力します。privileged publish jobは`judge-image-publish` environmentへ結び付くため、
repository settingsで必要なreviewerとdeployment policyを設定してください。

## 2. Receiptを検証する

workflowは検証jobでactual image contract、security suite、SBOM evidence、candidate review recordを確認し、
allowlisted contextだけを1日保持のartifactへ渡します。write権限を持つpublish jobはrepository codeをcheckout・実行せず、
そのcontextからlinux/amd64 imageをbuildします。`latest`は作成せず、source SHA tagは発見用に限ります。個人所有repositoryで
対象外のartifact storage recordは作成せず、registryへ付与したattestationとclosed receiptを正本にします。

完了後、`plugin-authoring-judge-image-publication-<source revision>` artifactから`receipt.json`を取得します。
receiptの`decision.status`は`published-candidate`、blockerは`independent-review`だけでなければなりません。
runnerへ使う正本は次の形式の`image.reference`です。

初回publish後はGitHub package settingsでcontainer visibilityを確認し、公開OSSとして配布する場合はpublicに設定します。
未認証の環境からdigest固定pullできない間は「公開済み」と案内しません。visibility変更はworkflowの自動処理に含めず、
repository/package ownerが明示的に判断します。

```text
ghcr.io/albert-einshutoin/tenantscript-plugin-authoring-judge@sha256:<64 lowercase hex>
```

tagではなくreceiptのdigestを指定して検証します。repository rootから次のverifierを実行すると、receiptを
closed schemaで再検証し、空の一時`DOCKER_CONFIG`と`GH_CONFIG_DIR`を使って未認証pull、完全一致する
`RepoDigests`、source-bound provenanceを固定順序で確認します。ambientなDocker/GitHub credential、`HOME`、
token環境変数は子processへ渡しません。

```sh
# cwd: repository root
# expected-exit: 0
node scripts/plugin-authoring-judge-image-verify.mjs path/to/receipt.json
```

verifierが成功しない限り公開済みとして扱いません。空credentialでpullできない、inspect結果に完全一致する
`image.reference`がない、attestation subjectがreceipt digestと一致しない場合は停止します。local image IDやSHA tagへの
一致で代用しません。成功時のclosed JSONも`verified-publication-candidate`であり、`independent-review` blockerを維持します。

## 3. Attestationを検証する

verifierは内部でGitHub CLIをshellなしの固定argvで呼び、subject digest、repository owner、workflow identityを検証します。
調査時に同じ境界を手動確認する場合の正本コマンドは次です。

```sh
# expected-exit: 0
gh attestation verify "oci://<image.reference>" \
  --repo albert-einshutoin/TenantScript \
  --signer-workflow albert-einshutoin/TenantScript/.github/workflows/publish-judge-image.yml \
  --source-digest "<source.revision>" \
  --bundle-from-oci \
  --deny-self-hosted-runners
```

receiptの`attestation.url`も同じrepositoryのattestation IDを指す必要があります。registry digestまたはattestationの
どちらか一方でも確認できなければ、runner requestを作成せずpublish workflowを調査します。

## 4. Approval境界

publish成功はregistry digestとprovenanceの証拠です。独立review、agent生成品質、未知の脆弱性不存在を証明しません。
`published-candidate`からreviewed imageへの昇格は別のreview recordで行い、`independent-review` blockerが残る間は
production相当のagent trialへ使用しません。rollbackは公開済みtagの上書き・削除ではなく、別途review済みの過去digestへ
requestを戻す操作として扱います。
