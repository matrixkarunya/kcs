import { createHmac, timingSafeEqual } from "crypto";
import { adminDb } from "./firebase-admin";
import type { BankQuestion } from "./relay";

let cache: { at: number; questions: BankQuestion[] } | null = null;

export async function getBank(): Promise<BankQuestion[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.questions;
  const snap = await adminDb().doc("config/relayBank").get();
  const questions = (snap.data()?.questions ?? []) as BankQuestion[];
  cache = { at: Date.now(), questions };
  return questions;
}

const secret = () => process.env.RELAY_SECRET ?? "matrix-relay-dev-secret";

export function signToken(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}