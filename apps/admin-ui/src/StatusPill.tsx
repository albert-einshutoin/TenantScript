export function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${statusTone(status)}`}>{status}</span>;
}

function statusTone(status: string): "ok" | "warning" | "critical" | "neutral" {
  if (status === "success" || status === "enabled" || status === "approved") {
    return "ok";
  }
  if (status === "pending") {
    return "warning";
  }
  if (status === "error" || status === "timeout" || status === "egress_denied") {
    return "critical";
  }
  return "neutral";
}
