"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { doc, getDoc, onSnapshot, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api-client";
import AppHeader from "@/components/app-header";
import TypingTest, { FinishPayload } from "@/components/typing-test";
import {
  COUNTDOWN_MS,
  LeaderRow,
  PRACTICE_SECONDS,
  PRACTICE_TEXT,
  RoundStatus,
  TypingScore,
  scoreTyping,
} from "@/lib/typing";

const PRACTICE_MAX = 3;
const practiceKey = (uid: string) => `typing-practice:${uid}`;

interface Cfg {
  roundId: string | null;
  name: string;
  durationSec: number;
  status: RoundStatus;
  startedAt: Timestamp | null;
  leaderboard: LeaderRow[] | null;
}

/* ---------- shared styles ---------- */

const shell =
  "min-h-screen bg-linear-to-br from-slate-50 via-[#eef2f6] to-teal-50/70";
const card =
  "rounded-2xl border border-white/70 bg-white/85 p-6 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5 backdrop-blur";
const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-linear-to-b from-teal-600 to-teal-700 px-5 py-2.5 font-semibold text-white shadow-md shadow-teal-700/20 transition hover:from-teal-500 hover:to-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 disabled:cursor-not-allowed disabled:opacity-50";

/* ---------- small components ---------- */

function Pill({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "slate" | "teal" | "amber" | "rose";
}) {
  const tones = {
    slate: "bg-slate-100 text-slate-700 ring-slate-200",
    teal: "bg-teal-50 text-teal-800 ring-teal-200",
    amber: "bg-amber-50 text-amber-800 ring-amber-200",
    rose: "bg-rose-50 text-rose-700 ring-rose-200",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function CountdownRing({ msLeft }: { msLeft: number }) {
  const r = 54;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, msLeft / COUNTDOWN_MS));
  return (
    <div className="relative mx-auto h-44 w-44">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="8"
          className="stroke-slate-200"
        />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          className="stroke-teal-600 transition-[stroke-dashoffset] duration-100 ease-linear"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <p className="text-5xl font-bold tabular-nums text-slate-900">
            {Math.ceil(msLeft / 1000)}
          </p>
          <p className="text-xs font-medium uppercase tracking-widest text-slate-500">
            seconds
          </p>
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <dt className="text-xs font-medium uppercase tracking-wider text-slate-500">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">
        {value}
      </dd>
    </div>
  );
}

function ResultCard({
  r,
  title,
  badge,
}: {
  r: TypingScore;
  title: string;
  badge?: ReactNode;
}) {
  return (
    <section className={card}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h2>
        {badge}
      </div>
      <p className="mt-4 flex items-baseline gap-2">
        <span className="bg-linear-to-r from-teal-600 to-emerald-500 bg-clip-text text-6xl font-extrabold tabular-nums text-transparent">
          {r.netWpm}
        </span>
        <span className="text-base font-medium text-slate-500">net WPM</span>
      </p>

      <div className="mt-5">
        <div className="flex justify-between text-xs font-medium text-slate-500">
          <span>Accuracy</span>
          <span className="tabular-nums text-slate-800">{r.accuracy}%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-linear-to-r from-teal-500 to-emerald-400"
            style={{ width: `${Math.max(0, Math.min(100, r.accuracy))}%` }}
          />
        </div>
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3">
        <StatTile label="Gross WPM" value={r.grossWpm} />
        <StatTile label="Characters" value={r.typed} />
        <StatTile label="Errors" value={r.errors} />
      </dl>
    </section>
  );
}

function AttemptDots({ used, max }: { used: number; max: number }) {
  return (
    <div
      className="flex items-center gap-1.5"
      role="img"
      aria-label={`${used} of ${max} practice attempts used`}
    >
      {Array.from({ length: max }).map((_, i) => (
        <span
          key={i}
          className={`h-2.5 w-2.5 rounded-full ring-1 ${
            i < used
              ? "bg-slate-300 ring-slate-300"
              : "bg-teal-500 ring-teal-600/40"
          }`}
        />
      ))}
    </div>
  );
}

function ConfirmModal({
  open,
  title,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/10"
      >
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-amber-100 text-amber-600">
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
        </div>
        <h2
          id="confirm-title"
          className="mt-4 text-center text-xl font-bold text-slate-900"
        >
          {title}
        </h2>
        <div className="mt-3 space-y-2 text-center text-sm leading-relaxed text-slate-600">
          {children}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button ref={cancelRef} className={btnGhost} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button className={btnPrimary} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- page ---------- */

export default function TypingPage() {
  const { profile } = useAuth();
  const uid = profile?.uid;

  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [offset, setOffset] = useState(0); // server time minus local time
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState<
    "loading" | "none" | "started" | "submitted"
  >("loading");
  const [result, setResult] = useState<TypingScore | null>(null);
  const [session, setSession] = useState<{
    passage: string;
    durationSec: number;
  } | null>(null);
  const [pending, setPending] = useState<FinishPayload | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [practice, setPractice] = useState(false);
  const [practiceRun, setPracticeRun] = useState(0);
  const [practiceUsed, setPracticeUsed] = useState(0);
  const [practiceResult, setPracticeResult] = useState<TypingScore | null>(
    null
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");

  const sawCountdown = useRef(false);
  const beginning = useRef(false);

  const roundId = cfg?.roundId ?? null;
  const status = cfg?.status;
  const practiceLeft = Math.max(0, PRACTICE_MAX - practiceUsed);

  // one listener on one small doc
  useEffect(
    () =>
      onSnapshot(
        doc(db, "config", "typing"),
        (s) => setCfg(s.exists() ? (s.data() as Cfg) : null),
        () => setCfg(null)
      ),
    []
  );

  // estimate server clock offset once
  useEffect(() => {
    const t0 = Date.now();
    fetch("/api/time")
      .then((r) => r.json())
      .then((d) => setOffset(d.now - (t0 + Date.now()) / 2))
      .catch(() => {});
  }, []);

  // remember how many practice attempts this student has used (this browser)
  useEffect(() => {
    if (!uid) return;
    try {
      const n = Number(localStorage.getItem(practiceKey(uid)) ?? 0);
      setPracticeUsed(Number.isFinite(n) ? Math.min(n, PRACTICE_MAX) : 0);
    } catch {
      /* storage unavailable: counter just lives in memory */
    }
  }, [uid]);

  // load my attempt whenever the round changes
  useEffect(() => {
    sawCountdown.current = false;
    beginning.current = false;
    setSession(null);
    setResult(null);
    setPending(null);
    setConfirmOpen(false);
    setError("");
    setAttempt("loading");
    if (!uid || !roundId) {
      setAttempt("none");
      return;
    }
    let alive = true;
    getDoc(doc(db, "typingAttempts", `${roundId}_${uid}`))
      .then((s) => {
        if (!alive) return;
        if (!s.exists()) return setAttempt("none");
        const d = s.data();
        if (d.status === "submitted") {
          setResult({
            typed: d.typed,
            correct: d.correct,
            errors: d.errors,
            accuracy: d.accuracy,
            grossWpm: d.grossWpm,
            netWpm: d.netWpm,
            elapsedMs: d.elapsedMs,
          });
          setAttempt("submitted");
        } else {
          setAttempt("started");
        }
      })
      .catch(() => alive && setAttempt("none"));
    return () => {
      alive = false;
    };
  }, [uid, roundId]);

  const startsAt =
    status === "running" && cfg?.startedAt
      ? cfg.startedAt.toMillis() + COUNTDOWN_MS
      : null;
  const msLeft = startsAt === null ? null : startsAt - (now + offset);

  // tick only while a countdown matters
  const needTick = startsAt !== null && attempt === "none" && !session;
  useEffect(() => {
    if (!needTick) return;
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [needTick]);

  const begin = useCallback(async () => {
    if (beginning.current || !roundId) return;
    beginning.current = true;
    setError("");
    try {
      const r = await api<{ passage: string; durationSec: number }>(
        "/api/typing/begin",
        { roundId }
      );
      setSession({ passage: r.passage, durationSec: r.durationSec });
      setAttempt("started");
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status === 425) {
        await new Promise((res) => setTimeout(res, 600));
        beginning.current = false;
        return begin();
      }
      if (err.message === "already-attempted") {
        setAttempt("started");
      } else if (err.message === "round-not-running") {
        setError("This round is not open.");
      } else {
        setError(
          `Could not start (${err.status ?? "?"}: ${err.message}). Tell an organiser.`
        );
      }
      // beginning.current stays true so the 100ms tick can't re-fire it
    }
  }, [roundId]);

  // synced start: begin automatically when the countdown ends
  useEffect(() => {
    if (msLeft === null || attempt !== "none" || session) return;
    if (msLeft > 0) {
      sawCountdown.current = true;
      return;
    }
    if (sawCountdown.current) begin();
  }, [msLeft, attempt, session, begin]);

  // manual start (after the modal confirmation) and manual retry
  const startConfirmed = useCallback(() => {
    setConfirmOpen(false);
    beginning.current = false;
    void begin();
  }, [begin]);

  const retryBegin = useCallback(() => {
    beginning.current = false;
    void begin();
  }, [begin]);

  const submit = useCallback(
    async (p: FinishPayload) => {
      setSession(null);
      setPending(p);
      setSubmitting(true);
      setError("");
      try {
        const r = await api<TypingScore>("/api/typing/submit", {
          roundId,
          typed: p.typed,
          times: p.times,
          untrusted: p.untrusted,
        });
        setResult(r);
        setAttempt("submitted");
        setPending(null);
      } catch {
        setError("Could not send your result. Check the connection and retry.");
      } finally {
        setSubmitting(false);
      }
    },
    [roundId]
  );

  const finishPractice = (p: FinishPayload) => {
    setPracticeResult(scoreTyping(PRACTICE_TEXT, p.typed, p.elapsedMs));
    const next = Math.min(practiceUsed + 1, PRACTICE_MAX);
    setPracticeUsed(next);
    if (uid) {
      try {
        localStorage.setItem(practiceKey(uid), String(next));
      } catch {
        /* ignore */
      }
    }
  };

  const openPractice = () => {
    if (practiceLeft <= 0) return;
    setPracticeResult(null);
    setPractice(true);
  };

  // ---------- screens ----------
  if (session) {
    return (
      <div className={shell}>
        <div className="mx-auto max-w-4xl p-6">
          <div className={card}>
            <TypingTest
              key={roundId}
              label="Scored round"
              passage={session.passage}
              durationMs={session.durationSec * 1000}
              onFinish={submit}
            />
          </div>
        </div>
      </div>
    );
  }

  if (practice) {
    const roundStartingSoon =
      msLeft !== null && msLeft > 0 && attempt === "none";
    return (
      <div className={shell}>
        <div className="mx-auto max-w-4xl space-y-5 p-6">
          {roundStartingSoon && (
            <div className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>
                The scored round starts in{" "}
                <strong className="tabular-nums">
                  {Math.ceil(msLeft / 1000)}s
                </strong>
                . Practice will end automatically.
              </span>
            </div>
          )}

          {practiceResult ? (
            <>
              <ResultCard
                r={practiceResult}
                title="Practice result (not scored)"
                badge={
                  <Pill tone="slate">
                    Attempt {practiceUsed} of {PRACTICE_MAX}
                  </Pill>
                }
              />
              <div className="flex flex-wrap items-center gap-3">
                <button
                  className={btnPrimary}
                  disabled={practiceLeft <= 0}
                  onClick={() => {
                    setPracticeResult(null);
                    setPracticeRun((n) => n + 1);
                  }}
                >
                  {practiceLeft > 0
                    ? `Try again (${practiceLeft} left)`
                    : "No attempts left"}
                </button>
                <button
                  className={btnGhost}
                  onClick={() => setPractice(false)}
                >
                  Back
                </button>
              </div>
            </>
          ) : (
            <div className={card}>
              <TypingTest
                key={practiceRun}
                label={`Practice, attempt ${Math.min(
                  practiceUsed + 1,
                  PRACTICE_MAX
                )} of ${PRACTICE_MAX} (not scored)`}
                passage={PRACTICE_TEXT}
                durationMs={PRACTICE_SECONDS * 1000}
                onFinish={finishPractice}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  const loading = cfg === undefined || attempt === "loading";

  return (
    <div className={shell}>
      <AppHeader title="Typing" />
      <main className="mx-auto max-w-3xl space-y-5 p-6">
        <Link
          href="/students"
          className="inline-flex items-center gap-1 text-sm font-medium text-teal-800 hover:underline"
        >
          <span aria-hidden="true">←</span> Back to events
        </Link>

        {loading ? (
          <div className={card}>
            <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
            <div className="mt-4 h-4 w-64 animate-pulse rounded bg-slate-200" />
          </div>
        ) : submitting ? (
          <div className={card}>
            <p className="text-sm font-medium text-slate-600">
              Sending your result…
            </p>
          </div>
        ) : pending ? (
          <div className={card}>
            <p role="alert" className="text-sm font-medium text-rose-700">
              {error}
            </p>
            <button
              className={`${btnPrimary} mt-4`}
              onClick={() => submit(pending)}
            >
              Retry sending
            </button>
          </div>
        ) : result ? (
          <>
            <ResultCard
              r={result}
              title="Your result"
              badge={<Pill tone="teal">Submitted</Pill>}
            />
            <p className="text-sm text-slate-600">
              Rankings will be announced by the organiser.
            </p>
          </>
        ) : attempt === "started" ? (
          <div className={card}>
            <Pill tone="amber">Attempt in progress</Pill>
            <p className="mt-3 text-sm leading-relaxed text-slate-700">
              Your test for this round has already been started, so it can&apos;t
              be restarted. If the page was refreshed, tell an organiser.
            </p>
          </div>
        ) : !cfg || status === "idle" ? (
          <div className={card}>
            <Pill>Waiting</Pill>
            <h2 className="mt-3 text-lg font-semibold text-slate-900">
              No round is open yet
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Wait for the organiser. You can practice in the meantime.
            </p>
          </div>
        ) : status === "lobby" ? (
          <div className={card}>
            <Pill tone="teal">Lobby open</Pill>
            <h2 className="mt-3 text-2xl font-bold text-slate-900">
              {cfg.name}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {cfg.durationSec} seconds. Wait for the organiser to start.
            </p>
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <strong>One scored attempt only.</strong> Once it starts it can
              not be paused or restarted.
            </div>
          </div>
        ) : status === "running" ? (
          <div className={card}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-bold text-slate-900">{cfg.name}</h2>
              <Pill tone="teal">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-600" />
                Live
              </Pill>
            </div>

            {msLeft !== null && msLeft > 0 ? (
              <div className="mt-6">
                <CountdownRing msLeft={msLeft} />
                <p className="mt-4 text-center text-sm text-slate-600">
                  Get ready. Your test begins automatically. This is your{" "}
                  <strong>only</strong> scored attempt.
                </p>
              </div>
            ) : sawCountdown.current ? (
              <p className="mt-4 text-sm font-medium text-slate-600">
                Starting…
              </p>
            ) : (
              <>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  The round is already running. You get the full{" "}
                  {cfg.durationSec} seconds from the moment you start.
                </p>
                <button
                  className={`${btnPrimary} mt-5`}
                  onClick={() => setConfirmOpen(true)}
                >
                  Start my test
                </button>
              </>
            )}

            {error && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
              >
                {error}
                <button
                  onClick={retryBegin}
                  className="ml-3 font-semibold underline"
                >
                  Retry
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={card}>
            <Pill>Closed</Pill>
            <p className="mt-3 text-sm text-slate-700">This round is closed.</p>
          </div>
        )}

        {status === "closed" && cfg?.leaderboard && (
          <section className={card}>
            <h2 className="text-lg font-semibold text-slate-900">
              Top results
            </h2>
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="py-2 font-medium">#</th>
                  <th className="py-2 font-medium">Student</th>
                  <th className="py-2 text-right font-medium">Net WPM</th>
                  <th className="py-2 text-right font-medium">Accuracy</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {cfg.leaderboard.map((r) => (
                  <tr key={r.rank} className="border-t border-slate-100">
                    <td className="py-2.5">
                      <span
                        className={`grid h-7 w-7 place-items-center rounded-full text-xs font-bold ${
                          r.rank === 1
                            ? "bg-amber-100 text-amber-700"
                            : r.rank === 2
                              ? "bg-slate-200 text-slate-700"
                              : r.rank === 3
                                ? "bg-orange-100 text-orange-700"
                                : "text-slate-500"
                        }`}
                      >
                        {r.rank}
                      </span>
                    </td>
                    <td className="py-2.5 font-medium text-slate-900">
                      {r.name}
                    </td>
                    <td className="py-2.5 text-right font-semibold tabular-nums">
                      {r.netWpm}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {r.accuracy}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {/* practice is available in every state */}
        {!loading && !pending && !submitting && (
          <section className={`${card} flex flex-wrap items-center justify-between gap-4`}>
            <div>
              <h2 className="font-semibold text-slate-900">Practice</h2>
              <p className="mt-1 text-sm text-slate-600">
                A {PRACTICE_SECONDS}-second sample. Not scored.{" "}
                {practiceLeft > 0
                  ? `${practiceLeft} of ${PRACTICE_MAX} attempts left.`
                  : "You have used all attempts."}
              </p>
              <div className="mt-2">
                <AttemptDots used={practiceUsed} max={PRACTICE_MAX} />
              </div>
            </div>
            <button
              className={btnGhost}
              disabled={practiceLeft <= 0}
              onClick={openPractice}
            >
              {practiceLeft > 0 ? "Start practice" : "No attempts left"}
            </button>
          </section>
        )}
      </main>

      <ConfirmModal
        open={confirmOpen}
        title="Start your one attempt?"
        confirmLabel="Yes, start now"
        cancelLabel="Go back"
        onConfirm={startConfirmed}
        onCancel={() => setConfirmOpen(false)}
      >
        <p>
          You only get <strong>one scored attempt</strong> for this round.
        </p>
        <p>
          The timer starts the moment you confirm. It cannot be paused or
          restarted, and refreshing or leaving the page will forfeit it.
        </p>
      </ConfirmModal>
    </div>
  );
}