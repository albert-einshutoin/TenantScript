import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";

const MAX_SUBJECT_LENGTH = 200;
const priorities = new Set(["low", "normal", "high"]);

interface TicketPayload {
  subject: string;
  priority?: "low" | "normal" | "high";
}

function normalizeTicketPayload(payload: unknown): Required<TicketPayload> {
  try {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("invalid ticket payload");
    }
    const rawSubject =
      "subject" in payload && typeof payload.subject === "string" ? payload.subject : "";
    // Bound the untrusted representation before trim allocates a normalized copy. Otherwise
    // whitespace padding can bypass the documented input limit while still consuming arbitrary
    // memory and CPU.
    const subject = rawSubject.length <= MAX_SUBJECT_LENGTH ? rawSubject.trim() : "";
    const priority = "priority" in payload ? payload.priority : "normal";
    if (
      subject.length === 0 ||
      subject.length > MAX_SUBJECT_LENGTH ||
      typeof priority !== "string" ||
      !priorities.has(priority)
    ) {
      throw new Error("invalid ticket payload");
    }
    return { subject, priority: (priority as TicketPayload["priority"]) ?? "normal" };
  } catch {
    // Accessor and Proxy traps are untrusted too; collapse every read failure to the same bounded
    // message so definePlugin cannot reflect attacker-controlled exception details.
    throw new Error("invalid ticket payload");
  }
}

export const plugin = definePlugin({
  manifest,
  handlers: {
    "ticket.created": async (payload, _context) => normalizeTicketPayload(payload)
  }
});

export default plugin;
