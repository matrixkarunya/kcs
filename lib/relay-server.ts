import { createHmac, timingSafeEqual } from "crypto";
import { adminDb } from "./firebase-admin";
import type { BankQuestion } from "./relay";

/* ----------------------------- Question bank ----------------------------- */

const BANK_TTL_MS = 60_000;

let cache: { at: number; questions: BankQuestion[] } | null = null;
let inflight: Promise<BankQuestion[]> | null = null;

async function loadBank(): Promise<BankQuestion[]> {
  const snap = await adminDb().doc("config/relayBank").get();
  const raw = snap.exists ? snap.data()?.questions : [];
  const questions = Array.isArray(raw) ? (raw as BankQuestion[]) : [];
  cache = { at: Date.now(), questions };
  return questions;
}

export async function getBank(): Promise<BankQuestion[]> {
  if (cache && Date.now() - cache.at < BANK_TTL_MS) return cache.questions;

  // Deduplicate concurrent refreshes so a burst of requests causes one read.
  if (!inflight) {
    inflight = loadBank()
      .catch((err) => {
        // If Firestore is unreachable, serve stale data rather than failing.
        if (cache) return cache.questions;
        throw err;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/* ------------------------------ Token signing ----------------------------- */

const DEFAULT_TTL_SECONDS = 2 * 60 * 60; // 2 hours

let cachedSecret: string | null = null;

function secret(): string {
  if (cachedSecret) return cachedSecret;
  const s = process.env.RELAY_SECRET;
  if (s) {
    cachedSecret = s;
    return s;
  }
  if (process.env.NODE_ENV === "production") {
    // Never fall back to a known secret in production: anyone could forge tokens.
    throw new Error("RELAY_SECRET environment variable is not set");
  }
  cachedSecret = "matrix-relay-dev-secret";
  return cachedSecret;
}

function sign(body: string): string {
  return createHmac("sha256", secret()).update(body).digest("base64url");
}

export function signToken(
  payload: object,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString(
    "base64url"
  );
  return `${body}.${sign(body)}`;
}

export function verifyToken<T extends object>(token: string): T | null {
  if (typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null) return null;

    // Reject expired (or exp-less) tokens.
    if (typeof data.exp !== "number" || data.exp < Date.now() / 1000) {
      return null;
    }
    return data as T;
  } catch {
    return null;
  }
}