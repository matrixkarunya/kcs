export const COUNTDOWN_MS = 10_000;
export const PRACTICE_SECONDS = 30;
export const PRACTICE_TEXT =
  "Practice makes the keys feel natural. Keep your eyes on the text and let your fingers find their own rhythm. There is no backspace in the real test, so a steady pace beats a fast mistake. Breathe, relax your shoulders, and type each word with care until the timer ends.";

export type RoundStatus = "idle" | "lobby" | "running" | "closed";

export interface LeaderRow {
  rank: number;
  name: string;
  username: string;
  netWpm: number;
  accuracy: number;
}

export interface TypingScore {
  typed: number;
  correct: number;
  errors: number;
  accuracy: number; // percent
  grossWpm: number;
  netWpm: number;
  elapsedMs: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

// No backspace: every keystroke is final, so errors are never corrected.
// Net WPM = ((chars / 5) - errors) / minutes
export function scoreTyping(
  passage: string,
  typed: string,
  elapsedMs: number
): TypingScore {
  const n = typed.length;
  let correct = 0;
  for (let i = 0; i < n; i++) if (typed[i] === passage[i]) correct++;
  const errors = n - correct;
  const minutes = Math.max(elapsedMs, 1000) / 60000;
  return {
    typed: n,
    correct,
    errors,
    accuracy: n === 0 ? 0 : r2((correct / n) * 100),
    grossWpm: r2(n / 5 / minutes),
    netWpm: r2(Math.max(0, (n / 5 - errors) / minutes)),
    elapsedMs,
  };
}