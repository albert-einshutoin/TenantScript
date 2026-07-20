# Release SBOM contract

TenantScriptは、検証済みnpm tarballをtruth sourceとしてCycloneDX 1.6 JSON SBOMを生成します。
source workspace全体のdependency一覧ではなく、利用者が実際にinstallする8 public packagesとproduction
dependency graphを対象にします。

## Accountless generation

```sh
# cwd: repository root
# expected-exit: 0
pnpm sbom:generate
```

出力は`.tmp/release-artifacts/tenantscript.cdx.json`です。既存artifactは上書きしないため、同じ
checkoutで再生成する場合は内容を確認してからoutput directoryを削除してください。generatorは次を行います。

1. [npm package release contract](npm-package-release.md)と同じsource-only build、tarball allowlist、
   size budget、clean install/import/type/CLI smokeを実行する
2. 全tarballをtemporary npm consumerへ`--ignore-scripts`でinstallし、production package lockを作る
3. [CycloneDX npm generator](https://github.com/CycloneDX/cyclonedx-node-npm)を
   `package-lock-only`、`omit dev`、reproducible output、schema validation付きで実行する
4. 8 public packages、`esbuild`、`semver`、`zod`と、rootから到達可能なdependency graphを再検証する
5. dev/test/build tools、重複`bom-ref`、machine-local path、credential形状を拒否する

同じinputから2回生成したSBOMがbyte-for-byteで一致することを`pnpm test:sbom`で常設検証します。
temporary tarball、package lock、install treeは成功・失敗の両方でcleanupされます。

## CI artifact

Tier 1はPRと`main` pushで同じgeneratorを実行し、`tenantscript-sbom-<commit SHA>`として14日間保持
します。[GitHub Actions artifact](https://docs.github.com/en/actions/tutorials/store-and-share-data)は
workflow完了後もdownloadできるため、reviewerは対象commitのSBOMを比較できます。fork PRでもCloudflare、
npm token、GitHub write permissionを必要としません。

## Security exception policy

SBOMまたはOSV/Snykがruntime dependencyの既知脆弱性を報告した場合、黙って除外・削除してはいけません。
修正versionへ更新するか、公開Issueに影響範囲、到達可能性、暫定mitigation、owner、期限を記録します。
未修正のCRITICAL/HIGHをrelease blockerから外すには、security maintainerの承認と期限付き再評価が必要です。
顧客情報、非公開exploit、credentialを公開IssueやSBOMへ含めず、[SECURITY.md](../../SECURITY.md)の
private reportingへ切り替えます。

## SBOM、provenance、releaseの境界

このartifactはdependency inventoryであり、署名、build provenance、npm publish完了の証明ではありません。
npm scope、2FA、trusted publishing、GitHub environment approval、registry provenance確認はIssue #3/#33の
external release laneです。tag/release workflowは独自SBOMを作らず、このaccountless入口を再利用します。
