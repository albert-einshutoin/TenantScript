# Secret KEK rotation

Control Planeが保存するprovider tokenの鍵暗号化鍵（KEK）を、token本体を再暗号化せずに
ローテーションする手順です。このrunbookはKEKの交換だけを扱います。SaaS側provider tokenの
失効・重複有効期間・再発行は別の運用です。

## 安全条件

作業を始める前に、次をすべて満たしてください。

- 対象deploymentに存在するsecret refの完全なinventoryが、信頼できるControl Planeの記録から
  取得できる。storage keyの推測や全体scanを正本にしない。
- 現在の設定、key ID別record件数、rollback判断者、incident連絡先を記録している。鍵material、
  token、customer payloadは記録しない。
- 旧KEKを復元できるbackupまたはsecret versionがあり、検証完了まで削除・無効化されない。
- 新KEKはCSPRNGで生成した32 byteで、paddingなしのcanonical base64urlとしてCloudflare Secret
  または同等のKMS境界だけに保存される。環境変数の表示、shell history、issue、PR、logへ出さない。
- storage adapterの`replaceIfUnchanged`が、同一recordに対する比較と更新を一つのtransactionで
  実行する。`get`後の無条件`put`による代用は認めない。

`createAesGcmSecretEncryptionKeyring`はkey ID、canonical encoding、32-byte長、current keyの存在を
fail closedで検証し、非extractableなAES-256-GCM `CryptoKey`へimportします。ただしJavaScriptの
入力文字列自体は消去できません。呼び出し元はsecret bindingから直接構成し、設定値を保持・表示・
serializeしないでください。

## ローテーション手順

1. **旧鍵を保持したまま新鍵を追加する。** 最初のdeployでは旧key IDを`currentKeyId`のままにし、
   旧鍵と新鍵の両方が`keys`から解決できることを起動時に検証する。
2. **currentを新鍵へ切り替える。** 旧鍵と新鍵を保持した設定をdeployし、新規・更新recordが新しい
   key IDで書かれることをsynthetic tenantで確認する。
3. **信頼できるinventoryを固定する。** 作業対象refと開始時のkey IDを記録する。token値や暗号文は
   exportしない。ローテーション中に追加されたrefも最終照合へ含める。
4. **refごとに`rewrapSecret(ref)`を実行する。** この操作はDEKだけを新KEKで包み直し、tokenの
   `iv`と`ciphertext`は変更しない。結果の`previousKeyId`、`currentKeyId`、`changed`だけを監査する。
5. **競合を明示的に処理する。** `secret_record_changed`は、OAuth再接続やtoken更新が先に完了した
   ことを示す。自動loopで盲目的に再試行せず、最新recordのkey IDとconnection状態を再取得し、
   operatorが同じrefを再度対象にする。上限回数を超える競合はincidentとして扱う。
6. **read pathを検証する。** 全refについて、broker内部の`getSecret`と最小権限のsynthetic
   capability checkが成功することを確認する。tokenを応答、log、検証レポートへ出さない。
7. **完全性を照合する。** inventoryの全refが新key IDを持ち、missing、旧key ID、未解決競合、
   read失敗が0件であることを別担当者が確認する。
8. **旧鍵を退役する。** 前項の証跡とrollback判断を承認した後の別deployでのみ旧鍵を削除する。
   削除後もsynthetic read/capability check、error rate、OAuth reconnectを監視する。

## 失敗時とrollback

- `secret_encryption_key_configuration_invalid`: deployを止める。key ID、encoding、byte長、current key
  の参照だけを確認し、materialをerrorへ含めない。
- `secret_encryption_key_unavailable`: 旧鍵を削除せず、対象recordのkey IDに対応するsecret versionを
  復元する。未知鍵のrecordを手動編集しない。
- `invalid_secret_record`: 改ざん、ref移動、破損を区別しようとして値を出力しない。incident responseへ
  移り、backupと監査証跡から影響scopeを調べる。
- `secret_record_changed`: 最新状態を再読込し、OAuth/token更新の完了を確認してから限定的に再実行する。

旧鍵を削除する前なら、`currentKeyId`を旧key IDへ戻し、旧鍵と新鍵の両方を保持してrollbackできます。
一件でもrewrap済みなら、全recordを再rewrapするかローテーションを完了するまで両方の鍵が必要です。
旧鍵削除後のrollbackを手順の一部として期待してはいけません。

## 禁止事項

- 全refの照合前に旧鍵を削除・失効しない。
- key material、token、暗号文を標準出力、CI artifact、issue、PRへ記録しない。
- envelope JSON、key ID、storage recordを手動編集しない。
- transactionを伴わない`get` + `put`でrewrapを実装しない。
- 競合、利用不能鍵、invalid recordを無制限retryで隠さない。
- この手順をlegacy plaintext移行やprovider-token rotationの代用にしない。

## Repositoryでの検証

以下はaccountlessな暗号・競合契約の検証です。production secret binding、実record inventory、
Cloudflare上のtransaction、実providerのtoken有効性を証明するものではありません。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/control-plane exec vitest run test/secret-store.test.ts
pnpm test:security
```

Production Wrangler input V4 declares `PROVIDER_SECRET_STORE_DO` as a SQLite-backed class owned by
the Control Plane Worker. Its namespace client hashes the tenant ID before selecting an object and
uses one storage transaction for ciphertext compare-and-swap. Provision the exact keyring JSON only
through `PROVIDER_SECRET_KEYRING_JSON`; Worker deletion and setup rollback are not evidence that the
secret namespace or its encrypted records were deleted.

暗号境界の設計は[ADR-005](../adr/005-secret-envelope-encryption.md)、漏えい・record移動・鍵運用の
脅威と検証証跡は[Threat model](../security/threat-model.md)を参照してください。
