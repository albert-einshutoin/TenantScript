# Manifest JSON Schema

TenantScriptはplugin manifestのcanonical structural contractをdraft-07 JSON Schemaとして公開します。
TypeScript以外のvalidator、editor補完、CIにはcommit済みの
[`tenantscript-manifest.schema.json`](tenantscript-manifest.schema.json)を使えます。Node.jsでは
`@tenantscript/manifest` packageから同じ内容をimportできます。

```ts
import { parseManifest, tenantScriptManifestJsonSchema } from "@tenantscript/manifest";

console.log(tenantScriptManifestJsonSchema.$id);
const result = parseManifest(candidate);
```

`tenantScriptManifestJsonSchema`はpackage import時に同じprivate Zod schemaから決定論的に生成され、
再帰的にfreezeされています。filesystem、network、registry、environment variableへアクセスしません。
commit済みJSON fileとの完全一致testにより、次のstructural constraintを固定します。

- top-level、hook、config field、egress、limitsはunknown propertyを許可しないclosed object
- 必須top-level fieldとhook field
- hook typeとconfig field typeのenum
- hook/limitのpositive integer、非空hook/allowlist、name/version pattern
- capability key patternとconfig keyの最小長

## Structural schemaとsemantic validation

JSON Schemaはportableなstructural validation用です。`schemaVersionRange`はnpm-compatible semver range
である必要がありますが、draft-07だけでsemver evaluatorを完全再現しません。schemaのdescriptionも
この境界を明記しています。registrationやexecution前のauthoritative semantic validationには必ず
`parseManifest`を使ってください。hook名の重複、config defaultと宣言typeの一致など、Zod refinementで
検証する規則も`parseManifest`が正本です。

JSON Schemaだけを通過した入力を「TenantScriptで有効」とみなしたり、semantic errorを独自に緩和したり
しないでください。逆に、editorの警告だけを理由にruntime parserを迂回してはいけません。

他言語runtimeやvalidatorは、implementation-independentな
[Manifest v1 Portable Specification](../spec/manifest-v1.md)とversioned JSON conformance corpusを
使ってstructural/semantic両方の判定互換性を確認できます。このconformanceはmanifest acceptanceの
契約であり、capability enforcement、tenant isolation、secret handling、runtime性能の証明ではありません。

## Versioning and changes

schemaの`$id`は公開repository内のcanonical JSON fileを指します。v1 schemaの互換変更は同じIDで
additiveに行い、required field追加、field削除、型・enum・patternの狭窄はbreaking changeとしてmajor
Changesetと[`docs/migrations/`](../migrations/README.md)のguideを要求します。実release後に新しいmajor
schemaを作る場合は、新しいversioned fileと`$id`を追加し、既存IDの意味を置き換えません。

変更時は生成元のZod schemaだけを編集し、JSON snapshotとの差分をreviewします。公開export名/kindは
`pnpm test:api-surface`、schema構造とparser behaviorはmanifest package tests、repository全体は
`pnpm verify`で検証します。snapshotだけを編集してparserとの差分を隠すことはできません。
