import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  CapabilityProviderError,
  createCapabilityBroker,
  createInMemoryCapabilityCallJournal,
  createInMemoryCapabilityRateLimiter,
  createPluginCapabilityContext,
  type CapabilityAuditRecord,
  type CapabilityGrant,
  type CapabilityProvider
} from "../src/index.js";

export interface CapabilityContractFixture {
  capability: string;
  grant: CapabilityGrant;
  allowedInput: unknown;
  deniedInput: unknown;
  createProvider: () => CapabilityProvider;
  expectedAllowedResult: unknown;
  expectedDeniedMessage: string;
  sensitiveValue?: string;
}

export function runCapabilityContract(fixture: CapabilityContractFixture): void {
  describe(`${fixture.capability} capability contract`, () => {
    it("allows a granted call, emits metadata-only success audit, and exposes no provider secret", async () => {
      const provider = vi.fn(fixture.createProvider());
      const audits: CapabilityAuditRecord[] = [];
      const broker = createCapabilityBroker({
        grants: { [fixture.capability]: fixture.grant },
        providers: { [fixture.capability]: provider },
        auditSink: {
          writeCapabilityAudit: (record) => {
            audits.push(record);
          }
        },
        now: fixedNow
      });
      const context = createPluginCapabilityContext(broker);

      await expect(context.capability(fixture.capability, fixture.allowedInput)).resolves.toEqual(
        fixture.expectedAllowedResult
      );
      expect(provider).toHaveBeenCalledOnce();
      expect(audits).toEqual([
        {
          capability: fixture.capability,
          status: "success",
          reason: "provider_completed",
          at: fixedNow()
        }
      ]);
      if (fixture.sensitiveValue !== undefined) {
        expect(JSON.stringify({ context, audits })).not.toContain(fixture.sensitiveValue);
      }
    });

    it("denies an ungranted call before the provider and emits a stable audit", async () => {
      const provider = vi.fn(fixture.createProvider());
      const audits: CapabilityAuditRecord[] = [];
      const broker = createCapabilityBroker({
        grants: {},
        providers: { [fixture.capability]: provider },
        auditSink: {
          writeCapabilityAudit: (record) => {
            audits.push(record);
          }
        },
        now: fixedNow
      });

      await expect(broker.call(fixture.capability, fixture.allowedInput)).rejects.toThrow(
        CapabilityDeniedError
      );
      expect(provider).not.toHaveBeenCalled();
      expect(audits).toEqual([
        {
          capability: fixture.capability,
          status: "denied",
          reason: "grant_missing",
          at: fixedNow()
        }
      ]);
    });

    it("enforces the capability-specific scope with a stable denial", async () => {
      const audits: CapabilityAuditRecord[] = [];
      const broker = createCapabilityBroker({
        grants: { [fixture.capability]: fixture.grant },
        providers: { [fixture.capability]: fixture.createProvider() },
        auditSink: {
          writeCapabilityAudit: (record) => {
            audits.push(record);
          }
        },
        now: fixedNow
      });

      await expect(broker.call(fixture.capability, fixture.deniedInput)).rejects.toThrow(
        fixture.expectedDeniedMessage
      );
      expect(audits).toEqual([
        {
          capability: fixture.capability,
          status: "denied",
          reason: fixture.capability === "invoice.read" ? "provider_denied" : "scope_denied",
          at: fixedNow()
        }
      ]);
    });

    it("replays a journaled result without a second provider call or duplicate audit", async () => {
      const provider = vi.fn(fixture.createProvider());
      const journal = createInMemoryCapabilityCallJournal();
      const audits: CapabilityAuditRecord[] = [];
      const createBroker = () =>
        createCapabilityBroker({
          executionId: `exec_${fixture.capability}`,
          journal,
          grants: { [fixture.capability]: fixture.grant },
          providers: { [fixture.capability]: provider },
          auditSink: {
            writeCapabilityAudit: (record) => {
              audits.push(record);
            }
          },
          now: fixedNow
        });

      await createBroker().call(fixture.capability, fixture.allowedInput);
      await createBroker().call(fixture.capability, fixture.allowedInput);

      expect(provider).toHaveBeenCalledOnce();
      expect(audits).toHaveLength(1);
    });

    it("rate-limits before provider execution and emits one denial audit", async () => {
      const provider = vi.fn(fixture.createProvider());
      const audits: CapabilityAuditRecord[] = [];
      const broker = createCapabilityBroker({
        grants: { [fixture.capability]: fixture.grant },
        providers: { [fixture.capability]: provider },
        rateLimiter: createInMemoryCapabilityRateLimiter({
          limits: { [fixture.capability]: { limit: 1, windowMs: 1_000 } }
        }),
        auditSink: {
          writeCapabilityAudit: (record) => {
            audits.push(record);
          }
        },
        now: fixedNow
      });

      await broker.call(fixture.capability, fixture.allowedInput);
      await expect(broker.call(fixture.capability, fixture.allowedInput)).rejects.toThrow(
        CapabilityDeniedError
      );

      expect(provider).toHaveBeenCalledOnce();
      expect(audits.at(-1)).toEqual({
        capability: fixture.capability,
        status: "denied",
        reason: "rate_limited",
        at: fixedNow()
      });
    });

    it("wraps provider failures without reflecting provider details", async () => {
      const providerSecret = `provider-secret-${fixture.capability}`;
      const audits: CapabilityAuditRecord[] = [];
      const broker = createCapabilityBroker({
        grants: { [fixture.capability]: fixture.grant },
        providers: {
          [fixture.capability]: () => {
            throw new Error(providerSecret);
          }
        },
        auditSink: {
          writeCapabilityAudit: (record) => {
            audits.push(record);
          }
        },
        now: fixedNow
      });

      let caughtError: unknown;
      try {
        await broker.call(fixture.capability, fixture.allowedInput);
      } catch (error: unknown) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(CapabilityProviderError);
      expect(String(caughtError)).not.toContain(providerSecret);
      expect(JSON.stringify(audits)).not.toContain(providerSecret);
      expect(audits).toEqual([
        {
          capability: fixture.capability,
          status: "error",
          reason: "provider_failed",
          at: fixedNow()
        }
      ]);
    });
  });
}

function fixedNow(): Date {
  return new Date("2026-07-20T00:00:00.000Z");
}
