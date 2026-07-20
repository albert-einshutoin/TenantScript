# Public API stability

TenantScriptは、公開packageのTypeScript exportとControl Plane REST routeを
[`api-surface.snapshot.json`](../../api-surface.snapshot.json)に固定します。snapshotは公開APIの
現在値を記録するaccountless evidenceであり、互換性を無条件に保証したり、breaking changeを
承認したりするものではありません。

## 常設gate

`pnpm test:api-surface`は次のsurfaceをsourceから再生成し、commit済みsnapshotと比較します。

- `private: true`ではない`packages/*/package.json`の全export subpath
- 各TypeScript entrypointのexport名と`type` / `value` / `type+value` kind
- `ADMIN_HTTP_ENDPOINT_CONTRACTS`のendpoint ID、path、HTTP method、tenant isolation class

re-exportはTypeScript compilerで解決します。`dist`、network、registry、Cloudflare account、日時、
machine-local pathには依存しません。Tier 1も同じcommandを実行するため、export削除、rename、
type/value kind変更、REST path/method/isolation変更はPull Requestでfailします。

manifestのbody構造は別の[Manifest JSON Schema](manifest-json-schema.md)と完全一致testで固定します。
現時点でControl Plane REST response body schema、runtime behavior、performanceはこのsnapshotの対象外です。
それらは型・integration/security test・benchmarkで別に守ります。

## 変更手順

surface driftが意図的な場合も、snapshotだけを先に更新してgateを回避してはいけません。

1. downstream利用者への影響を確認し、additive / compatible fix / breakingに分類する
2. breakingの場合はmigration guide、release note、該当packageのmajor changesetを同じPRへ含める
3. REST変更ではclient、CORS、RBAC、tenant isolation、error catalogの対応testを更新する
4. `pnpm api-surface:write`を実行し、JSON差分が意図した項目だけかreviewする
5. `pnpm test:api-surface`と`pnpm verify`を実行する

`pnpm test:release-policy`は`origin/main`のsnapshotと現在snapshotを比較します。export/subpathの削除、
export kind変更、Control Plane REST endpoint/path/isolation/methodの互換性破壊には、影響packageの
major Changesetと[`docs/migrations/`](../migrations/README.md)にある実在guideが必要です。snapshot更新
だけ、minor/patch Changeset、repository外のguideではmergeできません。API追加やsnapshot不変の変更に
不要なChangesetは強制しません。

## Failureの読み方

checkは期待snapshotと現在surfaceをcredential-freeなJSONで表示します。削除されたsymbolだけでなく、
追加されたsymbolもreview対象です。private implementationを誤ってexportした場合もpublic contractへ
固定される前に戻してください。

snapshotが欠落・malformedの場合は`Public API surface snapshot is invalid`でfailします。CIが
snapshotを自動生成・commitすることはありません。
