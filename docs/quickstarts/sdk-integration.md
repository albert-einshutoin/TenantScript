# SDK Integration Quickstart

host SaaSへtyped hookを追加し、plugin manifestとhandlerをTDDで接続する最小手順。最初はrepository内のaccountless testsで再現し、dry-run artifactを確認してからControl Planeへdeployする。

## 前提条件

- Node.js 24、Corepack、pnpm 10.12.1
- repository rootから実行
- host側とplugin側の担当境界を分ける。hostはpayload schemaとfailure policy、pluginはmanifest/handler/capability要求を所有する

```sh
# cwd: repository root
# expected-exit: 0
corepack enable
pnpm install --frozen-lockfile
```

## 1. Host: payload contractを先にtestする

Host SDKは`defineHooks`でevent/transform/policyを定義する。blocking hookは`budgetMs`必須で、標準failure policyはevent=`fail-open`、transform=`skip`、policy=`deny`である。

```ts
import { z } from "zod";
import { defineHooks } from "@tenantscript/host-sdk";

const invoiceCreated = z.object({
  invoiceId: z.string(),
  customerId: z.string(),
  amountCents: z.number().int().nonnegative()
});

export const hooks = defineHooks([
  { type: "event", name: "invoice.created", payloadSchema: invoiceCreated }
]);
```

不正payloadでhandlerが呼ばれないtestを先に書き、Host SDK contractを確認する。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/host-sdk test
```

## 2. Plugin: manifestをhandlerより先に固定する

manifestのhook名はhostと完全一致させ、raw provider tokenではなく必要なcapability scopeだけを宣言する。

```ts
import type { TenantScriptManifest } from "@tenantscript/manifest";

export const manifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250 }],
  capabilities: { "slack.send": { channel: "$config.notifyChannel" } },
  configSchema: {
    properties: { notifyChannel: { type: "string" } },
    required: ["notifyChannel"]
  },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;
```

## 3. Plugin: handlerとcapability testを実装する

```ts
import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";

export const plugin = definePlugin({
  manifest,
  handlers: {
    "invoice.created": async (payload, context) => {
      const invoice = payload as { invoiceId: string; amountCents: number };
      if (invoice.amountCents >= 100_000) {
        await context.capability("slack.send", {
          channel: "C123",
          text: `Large invoice ${invoice.invoiceId}`
        });
      }
    }
  }
});
```

plugin testではdeclared hookだけをdispatchできること、provider secretがcontextへ入らないこと、scope外capabilityが拒否されることを確認する。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/plugin-sdk test
pnpm --filter @tenantscript/capabilities test:security
```

## 4. Host + Plugin integrationを実行する

`apps/example-saas`はhost plan、plugin dispatch、scoped capability、execution logを接続したfork-safeなreference integrationである。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/example-saas test
```

期待結果:

- schema違反payloadはpluginを実行しない
- large invoiceだけがmock `slack.send`を1回呼ぶ
- execution logにtenant/plugin/hook/version/statusが残る
- raw Slack tokenはplugin contextとresultへ出ない

## 5. Deploy contractを検証する

実deploy前に、CLIがmanifest validation、version一致、deterministic bundle hashを確認する。repository内のdeploy contract testは外部accountを使わない。

```sh
# cwd: repository root
# expected-exit: 0
pnpm --filter @tenantscript/cli exec vitest run test/deploy.test.ts
```

実CLIの形は次のとおり。

```text
ext deploy --app <app-id> --plugin large-invoice-notify --version 1.0.0 --entry ./src/plugin.ts --manifest ./tenantscript.manifest.json --dry-run true
```

dry-runの`artifactHash`、manifest name/version/hooksをレビューしてから`--dry-run false`で登録する。token、config値、provider secretをmanifestやCLI引数へ置かない。installation作成時はAdmin UIでconfig/capability previewを確認する。

## 次に読む

- [SDK reference](../reference/sdk.md)
- [Usage meter operations](../operations/usage-meter.md)
- [Rollback troubleshooting](../operations/rollback-troubleshooting.md)
