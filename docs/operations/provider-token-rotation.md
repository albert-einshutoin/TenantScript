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

Control Planeの`createProviderTokenRotationManager`はactive/candidate/retiringをversioned closed JSONとして
1つのSecretStore envelopeへ保存します。状態metadataを平文D1へ分離せず、initialize、stage、promotion、
rollback、abort、finalizeをencrypted recordのtransactional compare-and-swapで更新します。mutation結果と
`inspect`は非secret token IDだけを返し、`resolveTokens`だけがtrusted capability compositionへraw tokenを
渡します。
Token IDはstrictな非secret identifier、token valueは非空かつ最大16 KiBです。上限超過はproviderの
異常応答または誤設定としてfail closedにし、切り詰めて保存しません。

## ローテーション手順

1. 初回接続は`initialize(active)`でencrypted token setを作成する。既存recordがある場合は上書きせず
   conflictとして停止する。
2. providerの正規手順でcandidateを発行する。activeを失効・削除せず、`stageCandidate(candidate)`で
   同じencrypted setへCAS追加する。raw token、暗号文、credential付きURLをlogやissueへ出さない。
3. synthetic tenantの最小権限capabilityでcandidate成功を確認する。結果metadataとtoken IDだけを監査する。
4. 通常trafficの成功率、credential拒否数、fallback数、rate limitを観測する。raw provider errorを
   公開auditへ保存しない。
5. 観測期間を満たしたら`promoteCandidate(candidateTokenId)`を実行する。同じCASでcandidateがactive、
   旧activeがretiringになり、retiringは通常snapshotから除かれる。
6. 問題があればrollback期間中に`rollbackToRetiring(retiringTokenId)`でactiveとretiringを原子的にswapする。
7. rollback期間とprovider側の失効条件を満たした後にだけ旧tokenをprovider側で失効し、
   `finalizeRetiring(retiringTokenId)`でencrypted setから除去する。finalize後はrepository stateだけでは
   rollbackできない。

candidate検証中に問題があれば、`abortCandidate(candidateTokenId)`でactive-only stateへ戻します。
credential拒否以外の障害は自動fallbackで隠さず、provider status、rate limit、scope、networkを調査します。

全transitionはCAS conflictで`provider token state changed concurrently`を返し、自動retryしません。最新の
非secret metadataを再取得し、並行OAuth再接続またはoperator操作を確認してから明示的に再実行します。

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
pnpm --filter @tenantscript/control-plane exec vitest run test/provider-token-rotation-store.test.ts test/secret-store.test.ts test/slack-oauth-client.test.ts
pnpm test:security
```

このaccountless testはfallback分類、上限、encrypted CAS、promotion/rollback/finalize、secret-free errorを
検証します。Slackのauthorization code交換はfixed-origin、exact redirect、one-shot、bounded responseの
HTTP clientまでrepository verifiedです。OAuth stateの発行・tenant/browser-boundな一回限り検証と、
state-firstでserver-owned scopeだけを接続境界へ渡すcallback serviceもrepository verifiedです。
認証済みinstall-start HTTP route、`__Host-` browser binding Cookie、bounded callback HTTP、固定redirect、
exchange/encrypted secret DO/sharded D1のWorker compositionもrepository verifiedです。Slack refresh tokenの
暗号化永続化とexpiry-aware更新state machine、Admin UI/CLI、provider側
失効、Cloudflare adapterのlive transactionはまだ検証しません。refresh credentialを失うtoken-rotation
responseは現時点でfail closedです。deploymentはこれらを追加し、実providerでcredential分類と無停止切替を
検証する必要があります。
