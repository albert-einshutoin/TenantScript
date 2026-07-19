# Zero-Integration Proxy Mode Quickstart

15分でStripeの`invoice.payment_succeeded` webhookをtenant別に変換し、既存billing endpointへ転送する。host SaaS本体のhook工事は不要で、最初にローカルE2Eで契約を確認してからstaging webhookの向き先を変更する。

## 前提条件（2分）

- Node.js 24
- Corepackとpnpm 10.12.1
- repositoryをclone済み
- production/staging導入時だけ、公開HTTPS Worker URLと転送先originが必要

```sh
# cwd: repository root
# expected-exit: 0
corepack enable
pnpm install --frozen-lockfile
```

## 1. 転送先をallowlistへ登録する（2分）

ローカルcontractで使うallowlistは次のとおり。実環境では`TENANTSCRIPT_PROXY_ALLOWED_ORIGINS`相当のsecretではない設定値として管理し、URL pathやtokenを含めずoriginだけを登録する。

```json tenantscript-proxy-allowlist
["https://billing.example.com"]
```

local、private、link-local、non-HTTP destinationはallowlistに書いてもsecurity suiteが拒否する。

## 2. inbound mappingを登録する（2分）

```json tenantscript-proxy-mapping
{
  "inboundPath": "/proxy/stripe/invoice-paid",
  "tenantId": "tenant_acme",
  "destinationUrl": "https://billing.example.com/webhooks/stripe",
  "transformHookName": "stripe.invoice.payment_succeeded.transform"
}
```

判断基準:

- `inboundPath`はtenantを一意に解決できるpathにする。
- `tenantId`をwebhook body/headerから受け取らない。mappingの保存値を信頼境界にする。
- `destinationUrl`のoriginは手順1と完全一致させる。
- `transformHookName`はinstallするplugin manifestのhook名と一致させる。

## 3. transform pluginをinstallする（3分）

`stripe.invoice.payment_succeeded.transform`を宣言するtransform pluginを同じtenantへinstallする。handlerは入力bodyを変更した新しいobjectとして返す。例外時はproxyが元payloadを転送するため、機密値をerror messageへ含めない。

このrepositoryのE2Eでは、次のStripe payloadを固定fixtureとして使用する。

```json stripe-invoice-payment-succeeded
{
  "id": "evt_invoice_paid_1",
  "type": "invoice.payment_succeeded",
  "livemode": false,
  "data": {
    "object": {
      "id": "in_123",
      "customer": "cus_456",
      "amount_paid": 12900,
      "currency": "usd"
    }
  }
}
```

## 4. ローカルE2Eを実行する（3分）

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/example-saas test -- zero-integration
```

期待結果はVitestのexit code `0`と、quickstart JSON snippetsを読み込む`zero-integration-proxy-mode quickstart` testの成功である。E2Eはmapping、tenant解決、transform、header保持、forwarded bodyを一続きで検証する。

転送先が受け取るbody:

```json billing-webhook-forwarded-body
{
  "eventType": "invoice.payment_succeeded",
  "invoiceId": "in_123",
  "customerId": "cus_456",
  "amountPaidCents": 12900,
  "currency": "usd",
  "livemode": false,
  "transformedBy": "tenantscript-zero-integration"
}
```

## 5. staging webhookを切り替える（3分）

Stripe stagingの送信先を次へ変更する。

```text
https://<your-worker-host>/proxy/stripe/invoice-paid
```

1件送信し、proxy resultが`transformed: true`、転送先が2xx、execution logのtenant/plugin/versionが期待どおりであることを確認する。Stripe署名検証はproxyの前段またはadapterで必ず実施し、署名secretをplugin contextへ渡さない。

## 失敗時の確認

| 症状                               | 確認する境界                                                  |
| ---------------------------------- | ------------------------------------------------------------- |
| mapping not found                  | request pathと`inboundPath`の完全一致                         |
| outside allowlist / not public URL | origin allowlist、HTTPS、private/link-local addressでないこと |
| `transformed: false`               | tenant installationがenabledでhook名が一致していること        |
| `skipped: true`                    | transform handlerのstructured errorと元payload転送を確認      |
| 転送先4xx/5xx                      | destination contract、署名/header、転送先logを確認            |

JSON snippetを変更する場合はE2Eも同じPRで更新する。`pnpm docs:check`はshell commandのworking directory、期待exit code、workspace filterに加え、`docs/`・`tasks/`の相対リンクとE2Eが参照するsnippet IDの存在・一意性を検証する。
