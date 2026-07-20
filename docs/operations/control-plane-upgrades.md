# Control Plane upgrade guide

このguideはself-host operatorが既存のControl Planeを安全に更新するための正本です。対象はD1
migrationと、その適用中も保持しなければならないR2 object、Durable Object stateです。schema
catalogの意味やhook schema廃止判定は[Schema migrations](schema-migrations.md)、pinned Wrangler runnerの
境界は[Cloudflare D1 migration setup adapter](cloudflare-d1-migrations.md)を参照してください。

## Evidence boundary

Tier 1のaccountless workerd testは、immutableな`pre-v1-0010` fixtureから現行schemaへ更新し、次を
repository verifiedとして常設確認します。

- D1のapp、tenant、plugin version、installation、approval、execution、audit dataを保持する。
- R2の既存keyとcontentを保持する。
- Durable Objectの既存stateを保持する。
- `d1_migrations` historyにより、同じmigration suffixを再送しても適用済みfileを実行し直さない。
- migration内のstatementが失敗した場合、そのmigration transactionが既存rowの変更を残さない。
- 更新後にimmutable audit、execution archive、runaway quarantineの現行schemaを利用できる。

`pre-v1-0010`は公開済みminor versionではなく、v1以前のsynthetic schema snapshotです。npmへまだ
存在しないreleaseをprevious versionとして扱いません。v1以降は、実際のrelease tagから作成した新しい
immutable baselineを追加します。fixtureは過去の契約なので既存fileを編集せず、新しいbaselineを追加します。

この証跡は実accountのbackup作成、remote apply、restoreを実行しません。Tier 2 live検証にはmaintainer
credentialが必要であり、実Cloudflare環境の成功証跡とは明確に分離します。

## Preflight

1. 対象environment、D1 database ID、R2 bucket、Durable Object namespaceが意図したappのbindingか、
   secret値を表示せず照合する。productionとpreviewを同じ記録に混ぜない。
2. deploy対象commitと`packages/control-plane/migrations`のpinned catalogを固定する。適用履歴がcatalogの
   正確なprefixでない場合は、履歴を手で直さず停止する。
3. D1の最新backupとrestore手段、R2 lifecycle/versioning方針、Durable Objectの互換class/bindingを確認する。
   backupの識別子、時刻、対象environmentだけをchange recordへ残し、customer dataは転記しない。
4. application writeを止める必要性とmaintenance windowを判断する。複数app databaseをrouteする構成では、
   databaseごとに履歴とbackupを確認し、一括成功とみなさない。
5. release noteに破壊的変更がある場合は対応するAPI migration guideを先に完了する。未確認のSQL、古い
   migrationの編集、手動`DROP`を含むupgradeは開始しない。

## Apply

production mutationはrepository-pinned Wrangler runnerを通し、remote historyの不足suffixだけを順番に
適用します。operator inputをSQLへ連結せず、`d1_migrations`を直接insert/updateしません。応答が失われた
場合は新しい経路でSQLを再実行せず、同じ設定で再開してhistoryを再読込させます。適用済みnameはskipされ、
不足suffixだけが候補になります。

D1 migrationはR2 objectやDurable Object storageを移動しません。ただしdeploy時にbinding名やDO classを
同時変更すると別stateへ接続し得るため、このupgradeでは既存bindingとclass migration設定を保持します。
binding変更が必要なreleaseは、独立したIssue、compatibility test、rollback planを要求します。

## Postflight

1. remote `d1_migrations`がpinned catalogの完全なprefixになったことをread-only queryで確認する。
2. syntheticな既知IDを使わず、対象environmentの承認済みsmoke手順でapp/tenant scope、installation read、
   execution search、audit chainを確認する。raw payloadやtokenをlogへ出さない。
3. R2はupgrade前に記録した非secret keyの存在、size、checksumを照合する。D1 archive metadataとobjectの
   対応が崩れていないことを確認する。
4. Durable Objectは既存namespace/classへrouteされ、既存counter/rate-limit stateが継続していることを
   serviceの公開health/behaviorから確認する。storageを直接書き換えない。
5. error rate、quarantine、approval滞留を観測し、change recordへcommit、migration names、開始/終了時刻、
   検証結果を残す。秘密情報やcustomer contentは残さない。

repository側では`pnpm --filter @tenantscript/control-plane test`でworkerd journeyを、最終的に`pnpm verify`で
Tier 1全体を確認します。

## Recovery

適用失敗時は追加migration、手動schema変更、traffic再開を止め、失敗したmigration nameとredacted error、
直前の成功history、backup識別子を保存します。Wranglerが失敗した単一migrationをrollbackしても、それ以前に
成功したmigrationは適用済みとして残り得るため、開始前versionへ戻ったと推測しません。

TenantScriptには**no automatic down migration**の方針があります。履歴tableの書換えや逆SQLの即興実行は
行いません。現行codeが適用済みprefixと互換なら原因を修正した新しいforward migrationをreviewし、互換で
なければmaintenanceを継続して承認済みCloudflare backup restore手順へ切り替えます。restore後はD1だけで
なく、同時刻のR2参照とDurable Object binding、audit continuityも再検証します。tenant境界、監査、secret
exposureへ影響する兆候があれば[Incident response](incident-response.md)へ引き上げます。
