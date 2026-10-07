export const COUNTDOWN_MS = 10_000;
export const PRACTICE_SECONDS = 30;
export const PRACTICE_TEXT =
  "practice makes the keys feel natural keep your eyes on the text and let your fingers find their own rhythm there is no backspace in the real test so a steady pace beats a fast mistake breathe relax your shoulders and type each word with care until the timer ends";

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

// ---------- extra detail for the admin (stored on the attempt) ----------

export interface Mistake {
  expected: string;
  typed: string;
  count: number;
}

export interface TypingDetail {
  wordsTotal: number; // words in the passage
  wordsDone: number; // passage words fully reached
  wordsCorrect: number; // of those, typed exactly right
  wordAccuracy: number; // percent of finished words typed exactly right
  progress: number; // percent of the passage covered
  firstKeyMs: number; // time until the first key
  avgGapMs: number; // average time between keys
  pauses: number; // gaps longer than 2 seconds
  longestPauseMs: number;
  peakWpm: number; // best 10 second window (gross)
  timelineWpm: number[]; // gross WPM per 10 second window
  timelineErr: number[]; // errors per 10 second window
  topMistakes: Mistake[];
  typedText: string;
}

const WINDOW_MS = 10_000;

export function detailTyping(
  passage: string,
  typed: string,
  times: number[],
  durationMs: number
): TypingDetail {
  // word spans in the passage
  const spans: [number, number][] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(passage)) !== null) spans.push([m.index, m.index + m[0].length]);

  let wordsDone = 0;
  let wordsCorrect = 0;
  for (const [s, e] of spans) {
    if (typed.length >= e) {
      wordsDone++;
      if (typed.slice(s, e) === passage.slice(s, e)) wordsCorrect++;
    }
  }

  // 10 second windows and mistake counts
  const windows = Math.max(1, Math.ceil(durationMs / WINDOW_MS));
  const chars = new Array<number>(windows).fill(0);
  const errs = new Array<number>(windows).fill(0);
  const mistakes = new Map<string, Mistake>();
  for (let i = 0; i < typed.length; i++) {
    const w = Math.min(windows - 1, Math.floor((times[i] ?? 0) / WINDOW_MS));
    chars[w]++;
    if (typed[i] !== passage[i]) {
      errs[w]++;
      const key = `${passage[i]}\u0000${typed[i]}`;
      const cur = mistakes.get(key);
      if (cur) cur.count++;
      else mistakes.set(key, { expected: passage[i] ?? "", typed: typed[i], count: 1 });
    }
  }
  const timelineWpm = chars.map((c, w) => {
    const len = Math.min(WINDOW_MS, durationMs - w * WINDOW_MS);
    return r2(c / 5 / (Math.max(len, 1000) / 60000));
  });

  // timing between keys
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  return {
    wordsTotal: spans.length,
    wordsDone,
    wordsCorrect,
    wordAccuracy: wordsDone ? r2((wordsCorrect / wordsDone) * 100) : 0,
    progress: passage.length ? r2((typed.length / passage.length) * 100) : 0,
    firstKeyMs: times[0] ?? 0,
    avgGapMs: Math.round(avgGap),
    pauses: gaps.filter((g) => g > 2000).length,
    longestPauseMs: gaps.length ? Math.max(...gaps) : 0,
    peakWpm: Math.max(0, ...timelineWpm),
    timelineWpm,
    timelineErr: errs,
    topMistakes: [...mistakes.values()].sort((a, b) => b.count - a.count).slice(0, 5),
    typedText: typed,
  };
}