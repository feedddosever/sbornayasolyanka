/**
 * Request guards for the API routes that spend Factor's Arkiv key.
 *
 * Every write those routes make is paid for in GLM by a server-side key, so an
 * unauthenticated, unthrottled endpoint is a way for anyone to drain it. The
 * routes authenticate the WHO with wallet signatures and on-chain state; this
 * file covers the HOW MUCH.
 */
import { NextRequest, NextResponse } from "next/server";

/**
 * A per-IP fixed-window limiter, in memory.
 *
 * Honest about its reach: on a serverless host each instance keeps its own
 * counters, so the real ceiling is `limit` times the number of warm
 * instances. That still turns "a loop drains the key in a minute" into "a
 * loop is throttled", which is the failure that matters for a demo. A shared
 * store (Upstash, Vercel KV) is the upgrade when it needs to be exact.
 */
const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(
  req: NextRequest,
  bucket: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): NextResponse | null {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  const key = `${bucket}:${ip}`;
  const now = Date.now();

  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) prune(now, windowMs);
    return null;
  }
  if (++w.count <= limit) return null;

  const retryAfter = Math.ceil((w.start + windowMs - now) / 1000);
  return NextResponse.json(
    { error: `Too many requests. Try again in ${retryAfter}s.` },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}

function prune(now: number, windowMs: number) {
  for (const [k, w] of windows) if (now - w.start >= windowMs) windows.delete(k);
}

/** Parse a JSON body, or say why not. */
export async function jsonBody(req: NextRequest): Promise<any | NextResponse> {
  try {
    const body = await req.json();
    if (body && typeof body === "object") return body;
  } catch {
    /* fall through */
  }
  return bad("body must be a JSON object");
}

export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** A non-negative integer from a string or number, or undefined. */
export function asUint(v: unknown): bigint | undefined {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
  return undefined;
}

/** ENS-shaped (or empty): lowercase labels, dots, hyphens, at most 255 chars. */
export const isEnsName = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 255 && /^([a-z0-9-]+(\.[a-z0-9-]+)*)?$/.test(v);

/**
 * An UNENCRYPTED Swarm reference (64 hex chars, optional 0x) or empty.
 *
 * 128 characters is refused on purpose: that is an encrypted reference, and
 * an encrypted reference carries its own decryption key. A listing is public,
 * so accepting one here would publish the private invoice.
 */
export const isPublicSwarmRef = (v: unknown): v is string =>
  typeof v === "string" && /^((0x)?[0-9a-f]{64})?$/i.test(v);
