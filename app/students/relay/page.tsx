"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { collection, doc, getDocs, onSnapshot, query, Timestamp, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { useProctor } from "@/lib/proctor";
import { api } from "@/lib/api-client";
import { runPython, warmUpPython } from "@/lib/py-runner";
import { normalizeOutput, PublicQuestion, TIER_LABEL, TYPE_LABEL } from "@/lib/relay";
import AppHeader from "@/components/app-header";

interface Cfg {
  roundId: string | null;
  name: string;
  status: "idle" | "lobby" | "running" | "closed";
  startedAt: Timestamp | null;
  durationMin: number;
  legSec: number;
  minPassSec: number;
  maxPerMember?: number;
  leaderboard:
    | { rank: number; team: string; solved: number; wrong: number; skipped?: number; timeSec: number }[]
    | null;
}
interface Team {
  name: string;
  memberNames: string[];
  order: string[];
  qIndex: number;
  holder: number;
  legStartedAt: Timestamp | null;
  solved: number;
  wrong: number;
  skipped?: number;
  bonusMs?: number;
  judgingSince?: Timestamp | null;
  memberCounts?: number[];
  endedEarly?: boolean;
  status: "waiting" | "active" | "finished";
}
type Question = PublicQuestion & { index: number; total: number };
interface TestResult {
  label: string;
  ok: boolean;
  error: string | null;
}
type Busy = "" | "run" | "check" | "submit" | "pass" | "skip" | "end";

const PAUSE_CAP = 60_000; // must match the server
const DEFAULT_CAP = 5;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const afterPaint = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn));

const card = "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm";
const btn =
  "rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50";
const btnDanger =
  "rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50";

function Spinner({ size = 48 }: { size?: number }) {
  return (
    <div
      className="animate-spin rounded-full border-4 border-slate-200 border-t-teal-600"
      style={{ width: size, height: size }}
    />
  );
}

export default function RelayPage() {
  const { profile } = useAuth();
  const { phase } = useProctor();
  const uid = profile?.uid;

  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [teamId, setTeamId] = useState<string | null | undefined>(undefined);
  const [team, setTeam] = useState<Team | null>(null);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [question, setQuestion] = useState<Question | null>(null);
  const [code, setCode] = useState("");
  const [inputText, setInputText] = useState("");
  const [runOut, setRunOut] = useState<{
    output: string;
    error: string | null;
    sampleMatch: boolean | null;
  } | null>(null);
  const [checkResults, setCheckResults] = useState<TestResult[] | null>(null);
  const [busy, setBusy] = useState<Busy>("");
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const [awaitNext, setAwaitNext] = useState(false); // waiting for the next question to show
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const passedFor = useRef(0);
  const resumeAfterQuestion = useRef(false);

  const running = cfg?.status === "running";
  const judging = busy === "check" || busy === "submit";

  // ---------- data ----------
  useEffect(
    () =>
      onSnapshot(
        doc(db, "config", "relay"),
        (s) => setCfg(s.exists() ? (s.data() as Cfg) : null),
        () => setCfg(null)
      ),
    []
  );

  useEffect(() => {
    warmUpPython();
    const t0 = Date.now();
    fetch("/api/time")
      .then((r) => r.json())
      .then((d) => setOffset(d.now - (t0 + Date.now()) / 2))
      .catch(() => {});
  }, []);

  // one login = one team
  useEffect(() => {
    if (!uid) return;
    getDocs(query(collection(db, "relayTeams"), where("uid", "==", uid)))
      .then((s) => setTeamId(s.empty ? null : s.docs[0].id))
      .catch(() => setTeamId(null));
  }, [uid]);

  useEffect(() => {
    if (!teamId) return;
    return onSnapshot(doc(db, "relayTeams", teamId), (s) =>
      setTeam(s.exists() ? (s.data() as Team) : null)
    );
  }, [teamId]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);

  // notices fade away by themselves
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  const resume = () => {
    if (teamId) api("/api/relay", { action: "resume", teamId }).catch(() => {});
  };

  // safety: never stay on the loader for ever
  useEffect(() => {
    if (!awaitNext) return;
    const t = setTimeout(() => {
      resumeAfterQuestion.current = false;
      resume();
      setAwaitNext(false);
    }, 12000);
    return () => clearTimeout(t);
  }, [awaitNext]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- derived ----------
  const serverNow = now + offset;
  // While the server has a pause running, the clock stands still at the pause start.
  const pausedSince = team?.judgingSince?.toMillis() ?? 0;
  const paused = !!pausedSince && serverNow - pausedSince < PAUSE_CAP;
  const effNow = pausedSince
    ? serverNow - pausedSince < PAUSE_CAP
      ? pausedSince
      : serverNow - PAUSE_CAP
    : serverNow;

  const bonus = team?.bonusMs ?? 0;
  const endsAt =
    running && cfg?.startedAt ? cfg.startedAt.toMillis() + cfg.durationMin * 60_000 + bonus : 0;
  const timeUp = running && endsAt > 0 && effNow >= endsAt;
  const total = team?.order.length ?? 0;
  const finished =
    !!team && (team.status === "finished" || (total > 0 && team.qIndex >= total));
  const arena = running && !!team && team.status === "active" && !finished && !timeUp;
  const legStartMs = team?.legStartedAt?.toMillis() ?? 0;

  const handoffMsLeft = arena && legStartMs > effNow ? legStartMs - effNow : 0;
  const handoff = handoffMsLeft > 0;

  const legMsLeft =
    arena && cfg && legStartMs
      ? Math.min(cfg.legSec * 1000, legStartMs + cfg.legSec * 1000 - effNow)
      : null;
  const totalMsLeft = endsAt - effNow;
  const passMsLeft = arena && cfg && legStartMs ? legStartMs + cfg.minPassSec * 1000 - effNow : null;
  const expired = !paused && legMsLeft !== null && legMsLeft <= 0;

  const nMembers = team?.memberNames.length ?? 0;
  const cap = cfg?.maxPerMember ?? DEFAULT_CAP;
  const counts = team?.memberNames.map((_, i) => team.memberCounts?.[i] ?? 0) ?? [];
  const doneByHolder = team ? counts[team.holder] ?? 0 : 0;
  const capReached = doneByHolder >= cap;
  const canPass = capReached || (passMsLeft !== null && passMsLeft <= 0);
  const holderName = team?.memberNames[team.holder] ?? "";
  const nextName = team ? team.memberNames[(team.holder + 1) % Math.max(1, nMembers)] : "";

  // ---------- question ----------
  useEffect(() => {
    if (!arena || !teamId) return;
    let alive = true;
    api<{ question: PublicQuestion; index: number; total: number }>("/api/relay", {
      action: "question",
      teamId,
    })
      .then((r) => {
        if (!alive) return;
        setQuestion({ ...r.question, index: r.index, total: r.total });
        setInputText(r.question.sampleInput);
        setRunOut(null);
        setCheckResults(null);
        // the clock restarts only once the student can actually see the new question
        if (resumeAfterQuestion.current) {
          resumeAfterQuestion.current = false;
          afterPaint(() => {
            resume();
            setAwaitNext(false);
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [arena, teamId, team?.qIndex, cfg?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps

  // the code lives in this browser only (survives a reload), never in the database
  const storeKey =
    teamId && question && cfg?.roundId
      ? `relay_code_${cfg.roundId}_${teamId}_${question.id}`
      : null;

  useEffect(() => {
    if (!question || !storeKey) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(storeKey);
    } catch {}
    setCode(saved ?? question.starterCode);
  }, [question, storeKey]);

  // automatic baton pass when the turn time runs out
  useEffect(() => {
    if (!expired || !teamId || !arena || legStartMs === 0) return;
    if (passedFor.current === legStartMs) return;
    passedFor.current = legStartMs;
    api("/api/relay", { action: "pass", mode: "timeout", teamId }).catch(() => {
      setTimeout(() => {
        passedFor.current = 0;
        setRetry((n) => n + 1);
      }, 3000);
    });
  }, [expired, legStartMs, teamId, arena, retry]);

  // ---------- editor ----------
  function setBoth(next: string) {
    setCode(next);
    setCheckResults(null);
    if (storeKey) {
      try {
        localStorage.setItem(storeKey, next);
      } catch {}
    }
  }
  function insert(text: string) {
    const el = taRef.current;
    if (!el) return;
    const s = el.selectionStart;
    setBoth(el.value.slice(0, s) + text + el.value.slice(el.selectionEnd));
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + text.length;
    });
  }
  function onEditorKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    if (e.key === "Tab") {
      e.preventDefault();
      insert("    ");
    } else if (e.key === "Enter") {
      e.preventDefault();
      const before = el.value.slice(0, el.selectionStart);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = (line.match(/^ */)?.[0] ?? "") + (line.trimEnd().endsWith(":") ? "    " : "");
      insert("\n" + indent);
    }
  }

  const errText = (e: unknown, fallback: string) => {
    switch ((e as Error).message) {
      case "time-up":
        return "Time is up.";
      case "handoff":
        return "Wait for the seat swap to finish.";
      case "member-done":
        return "This member has used all their questions. Pass the baton.";
      case "too-soon":
        return "It is too early to pass the baton.";
      case "no-next":
        return "No other member has questions left.";
      default:
        return fallback;
    }
  };

  // ---------- actions ----------
  // Run: your own input, unlimited, nothing stored, clock keeps running
  async function onRun() {
    if (busy || !question) return;
    setBusy("run");
    setRunOut(null);
    const [r] = await runPython(code, [inputText], 8000);
    const isSample = normalizeOutput(inputText) === normalizeOutput(question.sampleInput);
    setRunOut({
      output: r.output,
      error: r.error,
      sampleMatch:
        isSample && !r.error
          ? normalizeOutput(r.output) === normalizeOutput(question.sampleOutput)
          : null,
    });
    setBusy("");
  }

  // Check tests: the clock is paused on the server until the results are on screen
  async function onCheck() {
    if (busy || !teamId) return;
    setBusy("check");
    setCheckResults(null);
    setNotice(null);
    try {
      const { inputs } = await api<{ token: string; inputs: string[] }>("/api/relay", {
        action: "start",
        teamId,
      });
      const results = await runPython(code, inputs, 15000);
      const res = await api<{ results: boolean[] }>("/api/relay", {
        action: "check",
        teamId,
        outputs: results.map((r) => r.output),
      });
      setCheckResults(
        res.results.map((ok, i) => ({
          label: i === 0 ? "Sample test" : `Test ${i + 1}`,
          ok,
          error: results[i].error,
        }))
      );
    } catch (e) {
      setNotice({ kind: "bad", text: errText(e, "Could not check the tests. Try again.") });
    }
    setBusy("");
    afterPaint(resume);
  }

  // Submit: the only action that is scored
  async function onSubmit() {
    if (busy || !question || !teamId) return;
    setBusy("submit");
    setNotice(null);
    let waitForNext = false;
    try {
      const { token, inputs } = await api<{ token: string; inputs: string[] }>("/api/relay", {
        action: "start",
        teamId,
      });
      const results = await runPython(code, inputs, 15000);
      const res = await api<{ ok: boolean; finished: boolean }>("/api/relay", {
        action: "finish",
        teamId,
        token,
        outputs: results.map((r) => r.output),
      });
      if (res.ok && !res.finished) {
        waitForNext = true; // the clock stays paused until the next question shows
        resumeAfterQuestion.current = true;
        setAwaitNext(true);
      }
      setNotice(
        res.ok
          ? {
              kind: "ok",
              text: res.finished
                ? "Correct! Your team has finished."
                : "Correct! Here is the next question.",
            }
          : {
              kind: "bad",
              text: "Not correct. That counted as a wrong submit. Use Check tests to see which tests fail.",
            }
      );
    } catch (e) {
      setNotice({
        kind: "bad",
        text: errText(e, "Could not submit. Check the connection and try again."),
      });
    }
    setBusy("");
    if (!waitForNext) afterPaint(resume);
  }

  async function onSkip() {
    if (busy || !teamId || !team) return;
    setConfirmSkip(false);
    setBusy("skip");
    setNotice(null);
    let waitForNext = false;
    try {
      const r = await api<{ ok: boolean; finished: boolean }>("/api/relay", {
        action: "skip",
        teamId,
        qIndex: team.qIndex,
      });
      if (!r.finished) {
        waitForNext = true;
        resumeAfterQuestion.current = true;
        setAwaitNext(true);
      }
      setNotice({
        kind: "ok",
        text: r.finished ? "Skipped. That was the last question." : "Skipped. Here is the next question.",
      });
    } catch (e) {
      setNotice({ kind: "bad", text: errText(e, "Could not skip. Try again.") });
    }
    setBusy("");
    if (!waitForNext) afterPaint(resume);
  }

  async function onPass() {
    if (busy || !teamId) return;
    setBusy("pass");
    try {
      await api("/api/relay", { action: "pass", mode: "early", teamId });
    } catch (e) {
      setNotice({ kind: "bad", text: errText(e, "Could not pass the baton yet.") });
    }
    setBusy("");
  }

  async function onEnd() {
    if (busy || !teamId) return;
    setConfirmEnd(false);
    setBusy("end");
    try {
      await api("/api/relay", { action: "end", teamId });
    } catch (e) {
      setNotice({ kind: "bad", text: errText(e, "Could not end the section. Try again.") });
    }
    setBusy("");
  }

  // ---------- screens ----------
  let body: React.ReactNode;

  if (cfg === undefined || teamId === undefined) {
    body = (
      <div className="flex justify-center py-24">
        <Spinner />
      </div>
    );
  } else if (!teamId || !team) {
    body = <div className={card}>This login is not linked to a Code Relay team. Tell an organiser.</div>;
  } else if (!cfg || cfg.status === "idle") {
    body = <div className={card}>No relay round is open yet. Wait for the organiser.</div>;
  } else if (cfg.status === "lobby") {
    body = (
      <div className={`${card} text-center`}>
        <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Get ready</p>
        <h2 className="mt-1 text-2xl font-bold text-slate-900">{team.name}</h2>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {team.memberNames.map((m, i) => (
            <span key={m} className="rounded-full bg-teal-50 px-3 py-1 text-sm font-medium text-teal-900">
              {i + 1}. {m}
            </span>
          ))}
        </div>
        <p className="mx-auto mt-4 max-w-md text-sm text-slate-600">
          {cfg.name}: {cfg.durationMin} minutes in total, {Math.round((cfg.legSec / 60) * 10) / 10}{" "}
          minutes per turn, at most {cap} questions per member. Sit down in the order above and wait
          for the organiser to start.
        </p>
      </div>
    );
  } else if (cfg.status === "closed" || timeUp || finished) {
    body = (
      <>
        <div className={card}>
          <h2 className="text-xl font-bold text-slate-900">{team.name}</h2>
          <p className="mt-1 text-sm text-slate-700">
            {team.endedEarly
              ? "Your team ended the section."
              : finished
              ? "Your team went through every question."
              : "The round is over."}
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center">
            {[
              ["Solved", `${team.solved}/${total}`],
              ["Wrong submits", team.wrong],
              ["Skipped", team.skipped ?? 0],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl bg-slate-50 p-3">
                <p className="text-2xl font-bold text-slate-900">{v}</p>
                <p className="text-xs text-slate-500">{k}</p>
              </div>
            ))}
          </div>
        </div>
        {cfg.leaderboard && (
          <div className={card}>
            <h2 className="text-lg font-bold text-slate-900">Top teams</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">Team</th>
                  <th className="py-1 font-medium">Solved</th>
                  <th className="py-1 font-medium">Wrong</th>
                  <th className="py-1 font-medium">Skipped</th>
                  <th className="py-1 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {cfg.leaderboard.map((r) => (
                  <tr key={r.rank} className="border-t border-slate-100">
                    <td className="py-2 font-semibold">{r.rank}</td>
                    <td className="py-2">{r.team}</td>
                    <td className="py-2">{r.solved}</td>
                    <td className="py-2">{r.wrong}</td>
                    <td className="py-2">{r.skipped ?? 0}</td>
                    <td className="py-2">{fmt(r.timeSec * 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  } else if (!question) {
    body = (
      <div className="flex flex-col items-center gap-3 py-24 text-sm text-slate-600">
        <Spinner />
        Loading your question…
      </div>
    );
  } else {
    const locked = phase !== "active" || handoff || !!busy || awaitNext || capReached;
    const actionsOff = !!busy || handoff || awaitNext || capReached;
    const lowTotal = totalMsLeft < 60_000;
    const lowLeg = (legMsLeft ?? Infinity) < 30_000;
    body = (
      <>
        {/* status bar */}
        <div className="sticky top-0 z-30 -mx-4 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-bold text-slate-900">{team.name}</p>
              <p className="text-xs text-slate-500">
                Question {Math.min(team.qIndex + 1, total)} of {total}
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <span className="rounded-full bg-teal-50 px-3 py-1 font-semibold text-teal-800">
                Solved {team.solved}
              </span>
              <span className="rounded-full bg-red-50 px-3 py-1 font-semibold text-red-700">
                Wrong {team.wrong}
              </span>
              <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-700">
                Skipped {team.skipped ?? 0}
              </span>
            </div>
            <div className="text-right">
              <p className="text-xs text-slate-500">
                {paused ? "Round time (clock paused)" : "Round time left"}
              </p>
              <p
                className={`font-mono text-2xl font-bold tabular-nums ${
                  lowTotal ? "text-red-600" : "text-teal-700"
                }`}
              >
                {fmt(totalMsLeft)}
              </p>
            </div>
          </div>
        </div>

        {/* who is coding */}
        <div className="rounded-2xl border border-teal-200 bg-gradient-to-r from-teal-50 to-white px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Now coding</p>
              <p className="text-xl font-bold text-slate-900">{holderName}</p>
              <p className="text-xs text-slate-600">
                Questions used: <b>{doneByHolder}</b> of {cap}
                {nMembers > 1 && (
                  <>
                    {" "}
                    · Next up: <b>{nextName}</b>
                  </>
                )}
              </p>
            </div>
            <div className="flex items-center gap-5">
              <div className="text-right">
                <p className="text-xs text-slate-500">{paused ? "Turn (paused)" : "Turn ends in"}</p>
                <p
                  className={`font-mono text-3xl font-bold tabular-nums ${
                    lowLeg ? "text-red-600" : "text-slate-900"
                  }`}
                >
                  {fmt(legMsLeft ?? 0)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  className={capReached ? btn : btnGhost}
                  onClick={onPass}
                  disabled={!!busy || awaitNext || handoff || nMembers < 2 || !canPass}
                >
                  Pass the baton
                </button>
                {!canPass && passMsLeft !== null && (
                  <span className="text-xs text-slate-500">Early pass in {fmt(passMsLeft)}</span>
                )}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 border-t border-teal-100 pt-3">
            {team.memberNames.map((m, i) => (
              <span
                key={m}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  i === team.holder
                    ? "bg-teal-700 text-white"
                    : counts[i] >= cap
                    ? "bg-slate-200 text-slate-500 line-through"
                    : "bg-white text-slate-700 ring-1 ring-slate-200"
                }`}
              >
                {m} {counts[i]}/{cap}
              </span>
            ))}
          </div>
        </div>

        {capReached && (
          <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
            {holderName} has used all {cap} questions. Pass the baton to the next member.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-5">
          {/* question */}
          <div className={`${card} lg:col-span-2`}>
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700">
                {TIER_LABEL[question.tier]}
              </span>
              <span className="rounded-full bg-teal-100 px-3 py-1 text-teal-900">
                {TYPE_LABEL[question.type]}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-bold text-slate-900">{question.title}</h2>
            <p className="mt-2 whitespace-pre-wrap text-[15px] leading-relaxed text-slate-700">
              {question.prompt}
            </p>
            <div className="mt-5 space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Sample input
                </p>
                <pre className="mt-1 min-h-10 whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-sm text-slate-100">
                  {question.sampleInput || "(none)"}
                </pre>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Expected output
                </p>
                <pre className="mt-1 min-h-10 whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-sm text-emerald-300">
                  {question.sampleOutput}
                </pre>
              </div>
            </div>
            <p className="mt-4 text-xs text-slate-500">
              Your program is also tested on hidden values, so make it work for any valid input.
            </p>
          </div>

          {/* editor */}
          <div className={`${card} lg:col-span-3`}>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">main.py</p>
              {locked && !busy && <span className="text-xs font-medium text-amber-700">Editor locked</span>}
            </div>
            <textarea
              ref={taRef}
              value={code}
              onChange={(e) => setBoth(e.target.value)}
              onKeyDown={onEditorKey}
              readOnly={locked}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={16}
              className="w-full resize-y rounded-xl border border-slate-700 bg-slate-900 p-4 font-mono text-[15px] leading-6 text-slate-100 caret-teal-300 outline-none selection:bg-teal-700/50 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30"
            />

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Test input for Run
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                rows={2}
                spellCheck={false}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-2 font-mono text-sm normal-case tracking-normal text-slate-900 outline-none focus:border-teal-600"
              />
              <span className="font-normal normal-case tracking-normal">
                Starts as the sample. Type any value you like.
              </span>
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button className={btnGhost} onClick={onRun} disabled={actionsOff}>
                {busy === "run" ? "Running…" : "Run"}
              </button>
              <button className={btnGhost} onClick={onCheck} disabled={actionsOff}>
                Check tests
              </button>
              <button className={btn} onClick={onSubmit} disabled={actionsOff}>
                Submit
              </button>
              <span className="flex-1" />
              <button className={btnDanger} onClick={() => setConfirmSkip(true)} disabled={actionsOff}>
                Skip question
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Run and Check tests are free. Only Submit counts. The clock stops while your code is being
              judged and until the next screen is showing. A skipped question cannot be opened again.
            </p>

            {runOut && (
              <div className="mt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Output
                  {runOut.sampleMatch === true && (
                    <span className="ml-2 normal-case text-teal-700">Matches the expected output</span>
                  )}
                  {runOut.sampleMatch === false && (
                    <span className="ml-2 normal-case text-red-700">Does not match the expected output</span>
                  )}
                </p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-sm text-slate-100">
                  {runOut.output}
                  {runOut.error && (
                    <span className="text-red-300">
                      {runOut.output ? "\n" : ""}
                      {runOut.error}
                    </span>
                  )}
                </pre>
              </div>
            )}

            {checkResults && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <p className="font-semibold text-slate-900">
                  {checkResults.every((r) => r.ok)
                    ? "All tests passed. You can submit."
                    : `${checkResults.filter((r) => r.ok).length} of ${checkResults.length} tests passed.`}
                </p>
                <ul className="mt-2 space-y-1">
                  {checkResults.map((r) => (
                    <li key={r.label} className={r.ok ? "text-teal-800" : "text-red-700"}>
                      {r.ok ? "Passed" : "Failed"}: {r.label}
                      {!r.ok && r.error ? ` (${r.error})` : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-slate-500">
                  The other tests use hidden values, so their inputs are not shown.
                </p>
              </div>
            )}

            {notice && (
              <p
                role="status"
                className={`mt-4 rounded-lg p-3 text-sm font-medium ${
                  notice.kind === "ok" ? "bg-teal-50 text-teal-900" : "bg-amber-50 text-amber-900"
                }`}
              >
                {notice.text}
              </p>
            )}
          </div>
        </div>

        {/* end the section */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-100 bg-white px-5 py-4">
          <p className="max-w-xl text-sm text-slate-600">
            Done for today? Ending the section stops your team for good. It cannot be undone, and
            unanswered questions stay unsolved.
          </p>
          <button className={btnDanger} onClick={() => setConfirmEnd(true)} disabled={!!busy || awaitNext}>
            End section
          </button>
        </div>

        {/* judging / skipping / loading-next overlay */}
        {(judging || busy === "skip" || awaitNext) && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm">
            <div className="flex w-80 flex-col items-center gap-4 rounded-2xl bg-white p-8 text-center shadow-2xl">
              <Spinner size={64} />
              <p className="text-lg font-bold text-slate-900">
                {busy === "submit"
                  ? "Judging your submission…"
                  : busy === "check"
                  ? "Running the tests…"
                  : "Loading the next question…"}
              </p>
              <p className="text-sm text-slate-600">
                Your timer is paused. It resumes when the next screen is showing.
              </p>
            </div>
          </div>
        )}

        {/* seat swap overlay */}
        {handoff && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-teal-900/95 px-4 text-center text-white">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-teal-200">Swap seats</p>
              <p className="mt-4 text-4xl font-bold sm:text-5xl">{holderName} is up next</p>
              <p className="mt-10 font-mono text-[9rem] font-bold leading-none tabular-nums sm:text-[12rem]">
                {Math.ceil(handoffMsLeft / 1000)}
              </p>
              <p className="mt-6 text-teal-100">The editor opens when the countdown ends.</p>
            </div>
          </div>
        )}

        {/* skip confirmation */}
        {confirmSkip && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 px-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-slate-900">Skip this question?</h3>
              <p className="mt-2 text-sm text-slate-600">
                You will move on and cannot come back to this one. It counts as a skip and as one of{" "}
                {holderName}&apos;s {cap} questions.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button className={btnGhost} onClick={() => setConfirmSkip(false)}>
                  Keep working
                </button>
                <button className={btn} onClick={onSkip}>
                  Yes, skip
                </button>
              </div>
            </div>
          </div>
        )}

        {/* end confirmation */}
        {confirmEnd && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 px-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-lg font-bold text-red-700">End the section for your team?</h3>
              <p className="mt-2 text-sm text-slate-600">
                This is permanent. Nobody on your team can answer any more questions, and you cannot
                undo it.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button className={btnGhost} onClick={() => setConfirmEnd(false)}>
                  Cancel
                </button>
                <button
                  className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
                  onClick={onEnd}
                >
                  End for good
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Code Relay" />
      <main className="mx-auto max-w-6xl space-y-4 p-4">
        <Link href="/students" className="text-sm font-medium text-teal-800 hover:underline">
          Back to events
        </Link>
        {body}
      </main>
    </div>
  );
}