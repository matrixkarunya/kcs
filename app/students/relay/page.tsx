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
  status: "waiting" | "active" | "finished";
}
type Question = PublicQuestion & { index: number; total: number };
interface TestResult {
  label: string;
  ok: boolean;
  error: string | null;
}
interface Frozen {
  legLeft: number;
  totalLeft: number;
  legStart: number;
  bonus: number;
}
type Busy = "" | "run" | "check" | "submit" | "pass" | "skip";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

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
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const passedFor = useRef(0);

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

  // ---------- derived ----------
  const serverNow = now + offset;
  const bonus = team?.bonusMs ?? 0;
  const endsAt =
    running && cfg?.startedAt ? cfg.startedAt.toMillis() + cfg.durationMin * 60_000 + bonus : 0;
  const timeUp = running && !frozen && endsAt > 0 && serverNow >= endsAt;
  const total = team?.order.length ?? 0;
  const finished =
    !!team && (team.status === "finished" || (total > 0 && team.qIndex >= total));
  const arena = running && !!team && team.status === "active" && !finished && !timeUp;
  const legStartMs = team?.legStartedAt?.toMillis() ?? 0;

  const handoffMsLeft = arena && !frozen && legStartMs > serverNow ? legStartMs - serverNow : 0;
  const handoff = handoffMsLeft > 0;

  const liveLegLeft =
    arena && cfg && legStartMs
      ? Math.min(cfg.legSec * 1000, legStartMs + cfg.legSec * 1000 - serverNow)
      : null;
  const legMsLeft = frozen ? frozen.legLeft : liveLegLeft;
  const totalMsLeft = frozen ? frozen.totalLeft : endsAt - serverNow;
  const passMsLeft =
    arena && cfg && legStartMs && !frozen ? legStartMs + cfg.minPassSec * 1000 - serverNow : null;
  const expired = !frozen && legMsLeft !== null && legMsLeft <= 0;
  const nMembers = team?.memberNames.length ?? 0;
  const holderName = team?.memberNames[team.holder] ?? "";
  const nextName = team ? team.memberNames[(team.holder + 1) % Math.max(1, nMembers)] : "";

  function freeze() {
    setFrozen({
      legLeft: legMsLeft ?? 0,
      totalLeft: totalMsLeft,
      legStart: legStartMs,
      bonus,
    });
  }

  // release the frozen clock once the server has credited the pause (or after 3s)
  useEffect(() => {
    if (!frozen || judging) return;
    if (legStartMs !== frozen.legStart || bonus !== frozen.bonus) {
      setFrozen(null);
      return;
    }
    const t = setTimeout(() => setFrozen(null), 3000);
    return () => clearTimeout(t);
  }, [frozen, judging, legStartMs, bonus]);

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
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [arena, teamId, team?.qIndex, cfg?.roundId]);

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
    const m = (e as Error).message;
    if (m === "time-up") return "Time is up.";
    if (m === "handoff") return "Wait for the seat swap to finish.";
    return fallback;
  };

  // ---------- actions ----------
  // Run: your own input, unlimited, nothing stored
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

  // Check tests: sample + hidden tests, unlimited, nothing stored. Clock is paused.
  async function onCheck() {
    if (busy || !teamId) return;
    freeze();
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
  }

  // Submit: the only action that is scored. Clock is paused.
  async function onSubmit() {
    if (busy || !question || !teamId) return;
    freeze();
    setBusy("submit");
    setNotice(null);
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
      setNotice(
        res.ok
          ? {
              kind: "ok",
              text: res.finished
                ? "Correct! Your team has finished every question."
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
  }

  async function onSkip() {
    if (busy || !teamId || !team) return;
    setConfirmSkip(false);
    setBusy("skip");
    setNotice(null);
    try {
      const r = await api<{ ok: boolean; finished: boolean }>("/api/relay", {
        action: "skip",
        teamId,
        qIndex: team.qIndex,
      });
      setNotice({
        kind: "ok",
        text: r.finished ? "Skipped. That was the last question." : "Skipped. Here is the next question.",
      });
    } catch (e) {
      setNotice({ kind: "bad", text: errText(e, "Could not skip. Try again.") });
    }
    setBusy("");
  }

  async function onPass() {
    if (busy || !teamId) return;
    setBusy("pass");
    try {
      await api("/api/relay", { action: "pass", mode: "early", teamId });
    } catch {
      setNotice({ kind: "bad", text: "Could not pass the baton yet." });
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
          minutes per member. Sit down in the order above and wait for the organiser to start.
        </p>
      </div>
    );
  } else if (cfg.status === "closed" || timeUp || finished) {
    body = (
      <>
        <div className={card}>
          <h2 className="text-xl font-bold text-slate-900">{team.name}</h2>
          <p className="mt-1 text-sm text-slate-700">
            {finished ? "Your team went through every question. " : "The round is over. "}
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
    const locked = phase !== "active" || handoff || !!busy;
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
                {frozen ? "Round time (paused)" : "Round time left"}
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
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-teal-200 bg-gradient-to-r from-teal-50 to-white px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-teal-700">Now coding</p>
            <p className="text-xl font-bold text-slate-900">{holderName}</p>
            {nMembers > 1 && (
              <p className="text-xs text-slate-600">
                Next up: <b>{nextName}</b>
              </p>
            )}
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right">
              <p className="text-xs text-slate-500">{frozen ? "Turn (paused)" : "Turn ends in"}</p>
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
                className={btnGhost}
                onClick={onPass}
                disabled={!!busy || nMembers < 2 || (passMsLeft !== null && passMsLeft > 0)}
              >
                Pass the baton
              </button>
              {passMsLeft !== null && passMsLeft > 0 && (
                <span className="text-xs text-slate-500">Early pass in {fmt(passMsLeft)}</span>
              )}
            </div>
          </div>
        </div>

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
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                main.py
              </p>
              {phase !== "active" || handoff ? (
                <span className="text-xs font-medium text-amber-700">Editor locked</span>
              ) : null}
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
              <button className={btnGhost} onClick={onRun} disabled={!!busy || locked}>
                {busy === "run" ? "Running…" : "Run"}
              </button>
              <button className={btnGhost} onClick={onCheck} disabled={!!busy || handoff}>
                Check tests
              </button>
              <button className={btn} onClick={onSubmit} disabled={!!busy || handoff}>
                Submit
              </button>
              <span className="flex-1" />
              <button className={btnDanger} onClick={() => setConfirmSkip(true)} disabled={!!busy || handoff}>
                Skip question
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Run and Check tests are free. Only Submit counts, and the clock stops while your code is
              being judged. A skipped question cannot be opened again.
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

        {/* judging / skipping overlay */}
        {(judging || busy === "skip") && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm">
            <div className="flex w-80 flex-col items-center gap-4 rounded-2xl bg-white p-8 text-center shadow-2xl">
              <Spinner size={64} />
              <p className="text-lg font-bold text-slate-900">
                {busy === "submit"
                  ? "Judging your submission…"
                  : busy === "check"
                  ? "Running the tests…"
                  : "Moving to the next question…"}
              </p>
              {judging && (
                <p className="text-sm text-slate-600">
                  Your timer is paused. It resumes when the result arrives.
                </p>
              )}
            </div>
          </div>
        )}

        {/* seat swap overlay */}
        {handoff && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-teal-900/95 px-4 text-center text-white">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.3em] text-teal-200">
                Swap seats
              </p>
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
                You will move on to the next question and cannot come back to this one. It counts as a
                skip, which is used as a tie-breaker in the ranking.
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