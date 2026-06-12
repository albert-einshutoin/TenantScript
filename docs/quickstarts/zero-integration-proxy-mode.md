# Zero-Integration Proxy Mode Quickstart

This quickstart turns a Stripe `invoice.payment_succeeded` webhook into the shape expected by an existing billing endpoint without changing the host SaaS application. It is the lowest-friction TenantScript adoption path: point the webhook at TenantScript, transform the payload per tenant, and forward it to the original endpoint.

## 1. Allow the original billing endpoint

```json tenantscript-proxy-allowlist
["https://billing.example.com"]
```

## 2. Add the inbound mapping

```json tenantscript-proxy-mapping
{
  "inboundPath": "/proxy/stripe/invoice-paid",
  "tenantId": "tenant_acme",
  "destinationUrl": "https://billing.example.com/webhooks/stripe",
  "transformHookName": "stripe.invoice.payment_succeeded.transform"
}
```

The destination origin must be in the allowlist. Local, private, link-local, and non-HTTP destinations are rejected by the proxy security suite.

## 3. Install the transform plugin

Register a transform plugin for `stripe.invoice.payment_succeeded.transform`. In this quickstart the plugin normalizes Stripe's nested invoice event into the smaller contract the billing endpoint already accepts.

## 4. Point Stripe at the proxy URL

Configure Stripe's webhook destination to use the proxy path from the mapping:

```text
https://<your-worker-host>/proxy/stripe/invoice-paid
```

Use this Stripe event shape to smoke-test the setup locally:

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

## 5. Verify the forwarded payload

The original billing endpoint receives the normalized body below, with the same HTTP method and request headers that arrived at the proxy.

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

## CI guard

The example SaaS E2E reads the JSON snippets in this guide and executes the proxy flow against them:

```sh
pnpm --filter @tenantscript/example-saas test -- zero-integration
```

Update the snippets and the E2E together whenever the quickstart contract changes.
