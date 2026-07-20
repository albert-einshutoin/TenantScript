# Admin UI performance budget

TenantScript Admin UIのproduction bundle転送量を、fork-safeなTier 1で継続監視する契約です。装飾や依存追加によって初回表示が静かに肥大化することと、dynamic chunkへ移すだけの予算回避を防ぎます。

## Verification status

- **Repository verified** — `pnpm test:admin-ui-bundle-budget`はproduction Vite buildを作成し、manifestと出力fileをgzip level 9で計測します。
- **Not live verified** — bundle transfer sizeはbrowser rendering、interaction latency、Core Web Vitals、network cache、Cloudflare Pagesの圧縮設定を測りません。This is not runtime performance evidence.

## Budgets

正本は[`apps/admin-ui/bundle-budget.json`](../../apps/admin-ui/bundle-budget.json)です。

| Measurement        |                   Limit | 2026-07-21 baseline |
| ------------------ | ----------------------: | ------------------: |
| Initial page       | 307,200 bytes (300 KiB) |        91,377 bytes |
| All JavaScript/CSS | 460,800 bytes (450 KiB) |        91,110 bytes |

initial pageは`index.html`、Vite manifestのentry JavaScript、すべてのsynchronous imports、それらのCSSと直接参照assetを含みます。各HTTP assetを個別にgzipしたbyte数を合算します。

全JavaScript/CSS予算は、initial graphに含まれないdynamic chunksも含むbuild output全体です。routeをlazy loadへ変更しても、総量肥大化を隠せません。sourcemap、symlink、build directory外のpath、unknown output形式、欠落manifest recordは計測せずfail closedにします。

## Run locally

```sh
# cwd: repository root
# expected-exit: 0
pnpm test:admin-ui-bundle-budget
```

成功時は現在値、上限、initial asset、全JavaScript/CSS assetをmachine-readable JSONで出力します。source内容、machine-local absolute path、environment、credentialは出力しません。

## Updating the budget

予算は現在のbuildへ自動追随させません。超過した場合は、不要な依存、tree shaking、route boundary、CSS重複を先に調査してください。

予算を引き上げるPRには、少なくとも次を記載します。

1. gzipのbefore/afterと増加したasset。
2. 増加がユーザー価値に必要な理由と、より小さい実装を採用できない理由。
3. initial pageとdynamic chunksのどちらへ影響するか。
4. keyboard/E2E、security、visual behaviorを維持した証跡。
5. runtime performanceを主張する場合は、bundle gateとは別のbrowser/live計測。

機能削減や最適化で余裕が増えた場合は、実測値に適切なheadroomを加えた値まで予算を下げられます。予算変更だけのPRで失敗をgreenにすることは禁止します。
