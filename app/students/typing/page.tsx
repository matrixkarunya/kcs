"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

interface Cfg {
  roundId: string | null;
  name: string;
  durationSec: number;
  status: RoundStatus;
  startedAt: Timestamp | null;
  leaderboard: LeaderRow[] | null;
}

function ResultCard({ r, title }: { r: TypingScore; title: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold text-[#101828]">{title}</h2>
      <p className="mt-2 text-4xl font-bold text-teal-700">
        {r.netWpm} <span className="text-base font-medium text-slate-600">net WPM</span>
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-700 sm:grid-cols-4">
        <div><dt className="text-slate-500">Accuracy</dt><dd>{r.accuracy}%</dd></div>
        <div><dt className="text-slate-500">Gross WPM</dt><dd>{r.grossWpm}</dd></div>
        <div><dt className="text-slate-500">Characters</dt><dd>{r.typed}</dd></div>
        <div><dt className="text-slate-500">Errors</dt><dd>{r.errors}</dd></div>
      </dl>
    </div>
  );
}

const btn =
  "rounded-md bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700";
const btnGhost =
  "rounded-md border border-slate-300 px-4 py-2 text-slate-700 hover:bg-slate-100";

export default function TypingPage() {
  const { profile } = useAuth();
  const uid = profile?.uid;

  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [offset, setOffset] = useState(0); // server time minus local time
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState<"loading" | "none" | "started" | "submitted">("loading");
  const [result, setResult] = useState<TypingScore | null>(null);
  const [session, setSession] = useState<{ passage: string; durationSec: number } | null>(null);
  const [pending, setPending] = useState<FinishPayload | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [practice, setPractice] = useState(false);
  const [practiceRun, setPracticeRun] = useState(0);
  const [practiceResult, setPracticeResult] = useState<TypingScore | null>(null);
  const [error, setError] = useState("");

  const sawCountdown = useRef(false);
  const beginning = useRef(false);

  const roundId = cfg?.roundId ?? null;
  const status = cfg?.status;

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

  // load my attempt whenever the round changes
  useEffect(() => {
    sawCountdown.current = false;
    beginning.current = false;
    setSession(null);
    setResult(null);
    setPending(null);
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

  // practice ends when the round starts
  useEffect(() => {
    if (status === "running") setPractice(false);
  }, [status]);

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
      if (err.message === "already-attempted") setAttempt("started");
      else if (err.message === "round-not-running") setError("This round is not open.");
      else setError("Could not start your test. Tell an organiser.");
      beginning.current = false;
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

  // ---------- screens ----------
  if (session) {
    return (
      <div className="min-h-screen bg-[#eef2f6] p-6">
        <div className="mx-auto max-w-4xl">
          <TypingTest
            key={roundId}
            label="Typing test"
            passage={session.passage}
            durationMs={session.durationSec * 1000}
            onFinish={submit}
          />
        </div>
      </div>
    );
  }

  if (practice) {
    return (
      <div className="min-h-screen bg-[#eef2f6] p-6">
        <div className="mx-auto max-w-4xl space-y-4">
          {practiceResult ? (
            <>
              <ResultCard r={practiceResult} title="Practice result (not scored)" />
              <div className="flex gap-3">
                <button
                  className={btn}
                  onClick={() => {
                    setPracticeResult(null);
                    setPracticeRun((n) => n + 1);
                  }}
                >
                  Try again
                </button>
                <button className={btnGhost} onClick={() => setPractice(false)}>
                  Back
                </button>
              </div>
            </>
          ) : (
            <TypingTest
              key={practiceRun}
              label="Practice (not scored)"
              passage={PRACTICE_TEXT}
              durationMs={PRACTICE_SECONDS * 1000}
              onFinish={(p) =>
                setPracticeResult(scoreTyping(PRACTICE_TEXT, p.typed, p.elapsedMs))
              }
            />
          )}
        </div>
      </div>
    );
  }

  const canPractice = status === "idle" || status === "lobby" || !cfg;

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Typing" />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <Link href="/students" className="text-sm text-teal-800 hover:underline">
          Back to events
        </Link>

        {cfg === undefined || attempt === "loading" ? (
          <p className="text-sm text-slate-600">Loading…</p>
        ) : submitting ? (
          <p className="text-sm text-slate-600">Sending your result…</p>
        ) : pending ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p role="alert" className="text-sm text-red-700">{error}</p>
            <button className={`${btn} mt-3`} onClick={() => submit(pending)}>
              Retry sending
            </button>
          </div>
        ) : result ? (
          <>
            <ResultCard r={result} title="Your result" />
            <p className="text-sm text-slate-600">
              Rankings will be announced by the organiser.
            </p>
          </>
        ) : attempt === "started" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            Your test for this round has already been started, so it can&apos;t be
            restarted. If the page was refreshed, tell an organiser.
          </div>
        ) : !cfg || status === "idle" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            No round is open yet. Wait for the organiser.
          </div>
        ) : status === "lobby" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-[#101828]">{cfg.name}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {cfg.durationSec} seconds. One attempt only. Wait for the organiser
              to start.
            </p>
          </div>
        ) : status === "running" ? (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-[#101828]">{cfg.name}</h2>
            {msLeft !== null && msLeft > 0 ? (
              <p className="mt-3 text-5xl font-bold tabular-nums text-teal-700">
                {Math.ceil(msLeft / 1000)}
              </p>
            ) : sawCountdown.current ? (
              <p className="mt-3 text-sm text-slate-600">Starting…</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-slate-600">
                  The round is already running. You get the full {cfg.durationSec}{" "}
                  seconds from the moment you start.
                </p>
                <button className={`${btn} mt-3`} onClick={begin}>
                  Start my test
                </button>
              </>
            )}
            {error && (
              <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
            This round is closed.
          </div>
        )}

        {status === "closed" && cfg?.leaderboard && (
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-[#101828]">Top results</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">Student</th>
                  <th className="py-1 font-medium">Net WPM</th>
                  <th className="py-1 font-medium">Accuracy</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {cfg.leaderboard.map((r) => (
                  <tr key={r.rank} className="border-t border-slate-100">
                    <td className="py-1">{r.rank}</td>
                    <td className="py-1">{r.name}</td>
                    <td className="py-1">{r.netWpm}</td>
                    <td className="py-1">{r.accuracy}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canPractice && !result && attempt !== "started" && (
          <button
            className={btnGhost}
            onClick={() => {
              setPracticeResult(null);
              setPractice(true);
            }}
          >
            Practice for {PRACTICE_SECONDS} seconds
          </button>
        )}
      </main>
    </div>
  );
}