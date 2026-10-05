import { adminDb } from "./firebase-admin";

export interface Passage {
  id: string;
  text: string;
}

let cache: { at: number; passages: Passage[] } | null = null;

export async function getPool(fresh = false): Promise<Passage[]> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.passages;
  const snap = await adminDb().doc("config/typingPool").get();
  const passages = (snap.data()?.passages ?? []) as Passage[];
  cache = { at: Date.now(), passages };
  return passages;
}

export async function getPassageById(id: string): Promise<Passage | null> {
  const found = (await getPool()).find((p) => p.id === id);
  if (found) return found;
  return (await getPool(true)).find((p) => p.id === id) ?? null;
}

// Timing patterns that humans don't produce
export function analyzeTiming(times: number[]): string[] {
  const flags: string[] = [];
  if (times.length < 40) return flags;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(
    gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length
  );
  if (median < 35) flags.push("inhuman-speed");
  if (mean > 0 && sd / mean < 0.15) flags.push("uniform-timing");
  return flags;
}