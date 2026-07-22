import { definePlugin } from "@tenantscript/plugin-sdk";
import { manifest } from "./manifest.js";

const MAX_SUBJECT_LENGTH = 200;
const priorities = new Set(["low", "normal", "high"]);

interface TicketPayload {
  subject: string;
  priority?: "low" | "normal" | "high";
}

function normalizeTicketPayload(payload: unknown): Required<TicketPayload> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("invalid ticket payload");
  }
  const subject =
    "subject" in payload && typeof payload.subject === "string" ? payload.subject.trim() : "";
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
}

export const plugin = definePlugin({
  manifest,
  handlers: {
    "ticket.created": async (payload, _context) => normalizeTicketPayload(payload)
  }
});

export default plugin;
