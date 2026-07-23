# Release evidence

[`v1-launch-readiness.json`](v1-launch-readiness.json)は、TenantScript 1.xを公開してよいかを
machine-checkする閉じた判定レコードです。現在の正直な判定は`blocked`です。レコードは証拠を生成する
ものではなく、review済みの公開可能な証拠を参照して判定を固定するものです。

`approved`へ変更するには、5件のproduction adopter、10人のexternal contributor、1件の実
security advisory対応、critical/high未解決が0件の独立security review、2件の独立self-host検証、
v1 blocker issue 0件、CHANGELOGと告知文の全条件が必要です。

- synthetic drillは実security advisory対応に数えません。
- maintainerまたはbotだけの変更をexternal contributorに数えません。
- 自己レビューやCIを独立security reviewとして扱いません。
- private URL、credential付きURL、machine-local pathを証拠に記録しません。

判定器はレコードからblockerを固定順序で再計算し、手書きの虚偽`approved`を拒否します。確認には次を
実行します。

```sh
node scripts/v1-launch-readiness.mjs check docs/releases/v1-launch-readiness.json
```

1.xのrelease preflightはこのレコードが`approved`でなければ停止します。0.xは従来のpreflightを維持し、
2.x以降はそのmajor version専用のreadiness gateができるまで停止します。protected branch、protected
tag、`npm-publish` environmentのrequired reviewerは、引き続き最終的な人間の承認境界です。
