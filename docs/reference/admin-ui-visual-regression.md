# Admin UI visual regression gate

TenantScriptは、Admin UIのresponsive layoutと主要状態をPlaywright screenshotで比較します。
このgateはrepository内の決定論的な視覚退行を検出するもので、デザイン承認、axe、keyboard-only
journey、手動screen reader確認の代替ではありません。

## 保証するsurface

Linux Chromiumで、loginとOverview、Installations、Versions、Approval queue、Executions、
Connections、Audit logを320 / 768 / 1024 / 1440 pxで比較します。さらに1024 pxでempty、
loading、error、large dataset、privileged confirmation dialogを比較します。320 pxではpage全体に
横overflowがなく、tableの横overflowがラベル付きregion内へ閉じていることもassertします。

比較は`mcr.microsoft.com/playwright:v1.61.1-noble`と完全一致するPlaywright 1.61.1、UTC、
en-US、light color scheme、device scale factor 1、reduced motionで行います。animationとcaretを
停止し、`maxDiffPixels: 0`かつcolor threshold 0で比較するため、差分の黙認はありません。

## 実行方法

repository rootで次を実行します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:admin-ui-visual
```

すべてのhostで一時copyを隔離Dockerへ渡し、CIも同じLinux imageを使用します。`.git`、`.devloop`、
`node_modules`、build/test artifact、`.env*`、package-manager credential fileはcopyせず、credentialや
hostのpackage状態をcontainerへ渡しません。実行前にDocker daemonが利用可能であることを確認します。

## baseline更新

意図したUI変更を実装して全semantic testをgreenにした後だけ、次を実行します。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/admin-ui test:visual:update:linux
```

このcommandは一時copyをLinux containerへ渡し、既存baselineを消して全37枚を再生成してから、
PNGだけをworking treeへ戻します。browser/Playwright更新による一括変更は通常のUI変更と同じPRへ
混ぜず、image、dependency、描画差の理由を専用PRで説明してください。

baseline-only更新で実装差分を隠してはいけません。reviewerは次を確認します。

1. PR本文に変更理由、対象surface/state、viewportを記載した。
2. production codeまたは意図したstyle変更とbaselineの差が対応している。
3. expected / actual / diffを確認し、対象外のpixel差がない。
4. screenshot、trace、filenameがsynthetic dataだけを含み、実token、secret、customer data、
   secret referenceを含まない。
5. `pnpm test:admin-ui-visual`、axe、keyboard、security、最終`pnpm verify`がgreenである。

## CI failure artifact

Tier 1はvisual step失敗時に`test-results`とHTML reportを14日間保存します。Playwrightが出力する
expected、actual、diffを取得できますが、artifactを外部へ転載する前にもsecret-freeであることを
確認してください。baseline欠落、余分なbaseline、pixel差はfail closedです。
