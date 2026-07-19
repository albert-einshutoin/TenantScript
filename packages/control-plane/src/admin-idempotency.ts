export const adminIdempotencyRetentionMs = 24 * 60 * 60 * 1000;

export async function adminRequestFingerprint(canonicalRequest: unknown): Promise<string> {
  // Only the digest is persisted. Callers construct a field-bounded canonical DTO so config and
  // request values are never stored in plaintext or returned as part of the replay result.
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalRequest));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function adminIdempotencyExpiry(now: Date): string {
  return new Date(now.getTime() + adminIdempotencyRetentionMs).toISOString();
}
