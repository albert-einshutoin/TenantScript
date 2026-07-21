import {
  createCapabilityBroker,
  createMockSlackSendProvider,
  createPluginCapabilityContext,
  type CapabilityBroker
} from "@tenantscript/capabilities";
import {
  createExecutionUsageRecorder,
  createInMemoryExecutionLogStore,
  createInMemoryUsageMeter,
  type AnalyticsEngineDatasetLike,
  type ExecutionLogStore,
  type ExecutionUsageRecorder,
  type GetDailyUsageSummariesRequest,
  type GetDailyUsageSummaryRequest,
  type UsageHookType,
  type UsageMeter
} from "@tenantscript/control-plane";
import {
  planExecution,
  runTransformChain,
  type ExecutionStep,
  type Installation
} from "@tenantscript/host-sdk";
import {
  definePlugin,
  type DispatchResult,
  type TenantScriptPlugin
} from "@tenantscript/plugin-sdk";
import type { TenantScriptManifest } from "@tenantscript/manifest";

export interface InvoiceCreatedPayload {
  invoiceId: string;
  customerId: string;
  amountCents: number;
}

export interface WebhookPayload {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface SlackMessage {
  channel: string;
  text: string;
}

export interface ExampleSaasDemo {
  emitInvoiceCreated: (payload: InvoiceCreatedPayload) => Promise<void>;
  transformWebhookOutbound: (payload: WebhookPayload) => Promise<WebhookPayload>;
  slackMessages: readonly SlackMessage[];
  executionLog: ExecutionLogStore;
  usage: ExampleSaasUsageReader;
}

export interface ExampleSaasUsageReader {
  getDailyUsageSummary: UsageMeter["getDailyUsageSummary"];
  getDailyUsageSummaries: UsageMeter["getDailyUsageSummaries"];
}

export interface ExampleSaasDemoOptions {
  omitTransformPlugin?: boolean;
  usageAnalytics?: AnalyticsEngineDatasetLike;
}

const notifyManifest = {
  name: "large-invoice-notify",
  version: "1.0.0",
  hooks: [{ name: "invoice.created", type: "event", timeoutMs: 250, schemaVersionRange: "^1.0.0" }],
  capabilities: { "slack.send": { channel: "C123" } },
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

const transformManifest = {
  name: "payload-transformer",
  version: "1.0.0",
  hooks: [
    { name: "webhook.outbound", type: "transform", timeoutMs: 250, schemaVersionRange: "^1.0.0" }
  ],
  capabilities: {},
  configSchema: { properties: {}, required: [] },
  egress: { mode: "deny" },
  limits: { cpuMs: 50, timeoutMs: 500 }
} satisfies TenantScriptManifest;

export function createExampleSaasDemo(options: ExampleSaasDemoOptions = {}): ExampleSaasDemo {
  const slackMessages: SlackMessage[] = [];
  const executionLog = createInMemoryExecutionLogStore();
  const usageMeter = createInMemoryUsageMeter({
    ...(options.usageAnalytics === undefined ? {} : { analytics: options.usageAnalytics })
  });
  const executionUsageRecorder = createExecutionUsageRecorder({
    store: executionLog,
    usageMeter
  });
  const capabilityBroker = createCapabilityBroker({
    grants: { "slack.send": { channel: "C123" } },
    providers: {
      "slack.send": createMockSlackSendProvider({
        token: "xoxb-example-secret",
        deliver: (message) => slackMessages.push(message)
      })
    }
  });
  const plugins = createPlugins(options);
  const installations = createInstallations();

  return {
    slackMessages,
    executionLog,
    usage: createUsageReader(usageMeter),
    emitInvoiceCreated: (payload) =>
      emitInvoiceCreated({
        payload,
        installations,
        plugins,
        capabilityBroker,
        executionUsageRecorder
      }),
    transformWebhookOutbound: (payload) =>
      transformWebhookOutbound({
        payload,
        installations,
        plugins,
        capabilityBroker,
        executionUsageRecorder
      })
  };
}

async function emitInvoiceCreated(params: {
  payload: InvoiceCreatedPayload;
  installations: readonly Installation[];
  plugins: Record<string, TenantScriptPlugin>;
  capabilityBroker: CapabilityBroker;
  executionUsageRecorder: ExecutionUsageRecorder;
}): Promise<void> {
  const plan = planExecution({
    hookName: "invoice.created",
    hookType: "event",
    installations: params.installations
  });

  await Promise.all(
    plan.steps.map((step) =>
      dispatchAndRecord({
        step,
        hookName: "invoice.created",
        payload: params.payload,
        plugin: params.plugins[step.installationId],
        capabilityBroker: params.capabilityBroker,
        hookType: "event",
        executionUsageRecorder: params.executionUsageRecorder
      })
    )
  );
}

async function transformWebhookOutbound(params: {
  payload: WebhookPayload;
  installations: readonly Installation[];
  plugins: Record<string, TenantScriptPlugin>;
  capabilityBroker: CapabilityBroker;
  executionUsageRecorder: ExecutionUsageRecorder;
}): Promise<WebhookPayload> {
  const plan = planExecution({
    hookName: "webhook.outbound",
    hookType: "transform",
    installations: params.installations
  });

  return runTransformChain(plan, params.payload, async (step, currentPayload) => {
    const result = await dispatchAndRecord({
      step,
      hookName: "webhook.outbound",
      payload: currentPayload,
      plugin: params.plugins[step.installationId],
      capabilityBroker: params.capabilityBroker,
      hookType: "transform",
      executionUsageRecorder: params.executionUsageRecorder
    });

    if (!result.ok) {
      return currentPayload;
    }

    return result.value as WebhookPayload;
  });
}

function createPlugins(options: ExampleSaasDemoOptions): Record<string, TenantScriptPlugin> {
  const plugins: Record<string, TenantScriptPlugin> = {
    notify_installation: definePlugin({
      manifest: notifyManifest,
      handlers: {
        "invoice.created": async (payload, context) => {
          const invoice = payload as InvoiceCreatedPayload;
          if (invoice.amountCents >= 100_000) {
            await context.capability("slack.send", {
              channel: "C123",
              text: `Large invoice ${invoice.invoiceId}: ${String(invoice.amountCents)}`
            });
          }
        }
      }
    }),
    transform_installation: definePlugin({
      manifest: transformManifest,
      handlers: {
        "webhook.outbound": (payload) => {
          const webhook = payload as WebhookPayload;
          return {
            ...webhook,
            headers: {
              ...webhook.headers,
              "x-tenantscript-demo": "payload-transformer"
            },
            body: {
              ...webhook.body,
              transformedBy: "payload-transformer"
            }
          };
        }
      }
    })
  };

  if (options.omitTransformPlugin === true) {
    delete plugins.transform_installation;
  }

  return plugins;
}

function createInstallations(): Installation[] {
  return [
    {
      id: "notify_installation",
      tenantId: "tenant_1",
      pluginId: "large-invoice-notify",
      enabled: true,
      priority: 10,
      hooks: ["invoice.created"]
    },
    {
      id: "transform_installation",
      tenantId: "tenant_1",
      pluginId: "payload-transformer",
      enabled: true,
      priority: 10,
      hooks: ["webhook.outbound"]
    }
  ];
}

async function dispatchAndRecord(params: {
  step: ExecutionStep;
  hookName: string;
  payload: unknown;
  plugin: TenantScriptPlugin | undefined;
  capabilityBroker: CapabilityBroker;
  hookType: UsageHookType;
  executionUsageRecorder: ExecutionUsageRecorder;
}): Promise<DispatchResult> {
  const startedAt = performance.now();
  const result =
    params.plugin === undefined
      ? ({
          ok: false,
          error: {
            name: "MissingHandlerError",
            hookName: params.hookName
          }
        } satisfies DispatchResult)
      : await params.plugin.dispatch({
          hookName: params.hookName,
          payload: params.payload,
          context: createPluginCapabilityContext(params.capabilityBroker)
        });

  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  await params.executionUsageRecorder.record({
    execution: {
      id: `${params.step.installationId}:${params.hookName}:${String(startedAt)}`,
      tenantId: "tenant_1",
      pluginId: params.step.pluginId,
      hookName: params.hookName,
      version: "1.0.0",
      status: result.ok ? "success" : "error",
      durationMs,
      ...(result.ok
        ? {}
        : { error: "message" in result.error ? result.error.message : result.error.name }),
      capabilityCalls:
        params.hookName === "invoice.created" ? [{ name: "slack.send", status: "success" }] : [],
      createdAt: new Date("2026-06-12T00:00:00.000Z")
    },
    metrics: {
      hookType: params.hookType,
      // The accountless reference host has no platform billing counters. Zero is explicit and
      // safer than presenting elapsed wall time or inferred capability calls as provider CPU.
      cpuMs: 0,
      subrequests: 0,
      workflowRuns: 0
    }
  });

  return result;
}

function createUsageReader(usageMeter: UsageMeter): ExampleSaasUsageReader {
  return {
    getDailyUsageSummary: (request: GetDailyUsageSummaryRequest) =>
      usageMeter.getDailyUsageSummary(request),
    getDailyUsageSummaries: (request: GetDailyUsageSummariesRequest) =>
      usageMeter.getDailyUsageSummaries(request)
  };
}
