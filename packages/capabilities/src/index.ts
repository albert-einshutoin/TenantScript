export interface CapabilityGrant {
  channel?: string | readonly string[];
  fields?: readonly string[];
}

export type CapabilityGrants = Record<string, CapabilityGrant>;
export type CapabilityProvider = (input: unknown) => unknown;

export interface CapabilityBroker {
  call: (name: string, input: unknown) => Promise<unknown>;
}

export interface PluginCapabilityContext {
  capability: (name: string, input: unknown) => Promise<unknown>;
}

export class CapabilityDeniedError extends Error {
  override readonly name = "CapabilityDeniedError";
}

export function createCapabilityBroker(params: {
  grants: CapabilityGrants;
  providers: Record<string, CapabilityProvider>;
}): CapabilityBroker {
  return {
    call: async (name, input) => {
      const grant = params.grants[name];
      if (grant === undefined) {
        throw new CapabilityDeniedError(`capability ${name} is not granted`);
      }

      assertScope(name, grant, input);

      const provider = params.providers[name];
      if (provider === undefined) {
        throw new CapabilityDeniedError(`capability ${name} has no provider`);
      }

      return await provider(input);
    }
  };
}

export function createPluginCapabilityContext(broker: CapabilityBroker): PluginCapabilityContext {
  return {
    capability: (name, input) => broker.call(name, input)
  };
}

export function createMockSlackSendProvider(params: {
  token: string;
  deliver: (message: { channel: string; text: string }) => void;
}): CapabilityProvider {
  const tokenLength = params.token.length;
  if (tokenLength === 0) {
    throw new Error("mock Slack token must not be empty");
  }

  return (input) => {
    const message = parseSlackSendInput(input);
    params.deliver(message);
    return { ok: true, provider: "mock-slack" };
  };
}

function assertScope(name: string, grant: CapabilityGrant, input: unknown): void {
  if (name !== "slack.send") {
    return;
  }

  const message = parseSlackSendInput(input);
  const allowedChannels = grant.channel === undefined ? [] : [grant.channel].flat();
  if (allowedChannels.length > 0 && !allowedChannels.includes(message.channel)) {
    throw new CapabilityDeniedError(
      `slack.send channel ${message.channel} is outside granted scope`
    );
  }
}

function parseSlackSendInput(input: unknown): { channel: string; text: string } {
  if (!isRecord(input) || typeof input.channel !== "string" || typeof input.text !== "string") {
    throw new CapabilityDeniedError("slack.send requires channel and text");
  }

  return {
    channel: input.channel,
    text: input.text
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
