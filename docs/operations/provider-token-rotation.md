# Provider token rotation

外部SaaSのcredentialを、capability callを止めずに切り替えるためのintegration contractです。
これは保存recordを暗号化するKEK rotationとは別の操作です。KEKを交換する場合は
[Secret KEK rotation](secret-key-rotation.md)を使用してください。

## 実行モデル

`createRotatingTokenCapabilityProvider`は、callごとにtoken sourceから次のsnapshotを取得します。

- `active`: 現在稼働中で、rollbackに使用できるtoken。
- `candidate`: 切替を検証する新token。存在する間はcandidateを先に使用する。

provider adapterがcandidateを明示的な`ProviderCredentialRejectedError`として拒否した場合だけ、
activeへ最大1回fallbackします。timeout、network error、rate limit、scope/permission拒否、未知のerrorでは
fallbackしません。これらはprovider側で副作用が完了している可能性があり、別tokenでの再送は二重実行に
なるためです。

token sourceはsnapshotごとに異なる一意な非secret IDを返し、raw tokenは`invoke` callback以外へ
渡さないでください。source、snapshot、providerの失敗はstableでsecret-freeなerrorへ変換されます。

## ローテーション手順

1. providerの正規手順でcandidateを発行する。activeを失効・削除しない。
2. candidateをencrypted secret boundaryへ保存し、sourceが`active`と`candidate`の両方を返すように
   原子的に更新する。raw token、暗号文、credential付きURLをlogやissueへ出さない。
3. synthetic tenantの最小権限capabilityでcandidate成功を確認する。結果metadataとtoken IDだけを監査する。
4. 通常trafficの成功率、credential拒否数、fallback数、rate limitを観測する。raw provider errorを
   公開auditへ保存しない。
5. 観測期間を満たしたらcandidateを新しいactiveへpromotionする。旧activeはrollback期間中、別の
   retiring secretとして保持するが、通常snapshotからは除く。
6. rollback期間とprovider側の失効条件を満たした後にだけ旧tokenを失効し、secret recordを削除する。

candidate検証中に問題があれば、sourceからcandidateを除いてactive-only snapshotへ戻します。
credential拒否以外の障害は自動fallbackで隠さず、provider status、rate limit、scope、networkを調査します。

## Provider adapterの責任

- providerの公式なinvalid/expired credential responseだけを`ProviderCredentialRejectedError`へ変換する。
- status codeやmessageの広い一致でpermission不足、429、5xx、timeoutをcredential拒否に分類しない。
- `invoke` result/errorへtokenを含めない。
- mutationが冪等でない場合も、ambiguous failure後に独自retryを追加しない。

## Repositoryでの検証と未実装境界

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/capabilities exec vitest run test/provider-token-rotation.test.ts
pnpm test:security
```

このaccountless testはfallback分類、上限、snapshot更新、secret-free errorを検証します。productionの
token発行・暗号化永続化・promotion/finalize API・Admin UI/CLI・provider側失効はまだ実装しません。
deployment adapterはこれらを追加し、実providerでcredential分類と無停止切替を検証する必要があります。
