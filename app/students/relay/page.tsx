"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
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
  leaderboard: { rank: number; team: string; solved: number; wrong: number; timeSec: number }[] | null;
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
  status: "waiting" | "active" | "finished";
}
type Question = PublicQuestion & { index: number; total: number };
interface TestResult {
  label: string;
  ok: boolean;
  error: string | null;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const card = "rounded-xl border border-slate-200 bg-white p-4";
const btn =
  "rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50";
const btnGhost =
  "rounded-md border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50";

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
  const [busy, setBusy] = useState<"" | "run" | "check" | "submit" | "pass">("");
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [handoffUntil, setHandoffUntil] = useState(0);
  const [retry, setRetry] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const passedFor = useRef(0);
  const prevHolder = useRef<number | null>(null);

  const running = cfg?.status === "running";

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
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  // ---------- derived ----------
  const serverNow = now + offset;
  const endsAt =
    running && cfg?.startedAt ? cfg.startedAt.toMillis() + cfg.durationMin * 60_000 : 0;
  const timeUp = running && endsAt > 0 && serverNow >= endsAt;
  const total = team?.order.length ?? 0;
  const finished =
    !!team && (team.status === "finished" || (total > 0 && team.qIndex >= total));
  const arena = running && !!team && team.status === "active" && !finished && !timeUp;
  const legStartMs = team?.legStartedAt?.toMillis() ?? 0;
  const legMsLeft =
    arena && cfg && legStartMs ? legStartMs + cfg.legSec * 1000 - serverNow : null;
  const passMsLeft =
    arena && cfg && legStartMs ? legStartMs + cfg.minPassSec * 1000 - serverNow : null;
  const expired = legMsLeft !== null && legMsLeft <= 0;
  const handoff = handoffUntil > now;
  const nMembers = team?.memberNames.length ?? 0;
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

  // swap-seats banner when the baton moves
  useEffect(() => {
    if (!team) return;
    if (prevHolder.current !== null && prevHolder.current !== team.holder) {
      setHandoffUntil(Date.now() + 5000);
    }
    prevHolder.current = team.holder;
  }, [team?.holder]); // eslint-disable-line react-hooks/exhaustive-deps

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
      sampleMatch: isSample && !r.error
        ? normalizeOutput(r.output) === normalizeOutput(question.sampleOutput)
        : null,
    });
    setBusy("");
  }

  // Check tests: sample + hidden tests, unlimited, nothing stored
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
      setNotice({
        kind: "bad",
        text: (e as Error).message === "time-up" ? "Time is up." : "Could not check the tests. Try again.",
      });
    }
    setBusy("");
  }

  // Submit: the only action that is stored
  async function onSubmit() {
    if (busy || !question || !teamId) return;
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
        text: (e as Error).message === "time-up" ? "Time is up." : "Could not submit. Check the connection and try again.",
      });
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
    body = <p className="text-sm text-slate-600">Loading…</p>;
  } else if (!teamId || !team) {
    body = <div className={card}>This login is not linked to a Code Relay team. Tell an organiser.</div>;
  } else if (!cfg || cfg.status === "idle") {
    body = <div className={card}>No relay round is open yet. Wait for the organiser.</div>;
  } else if (cfg.status === "lobby") {
    body = (
      <div className={card}>
        <h2 className="font-semibold text-[#101828]">{team.name}</h2>
        <p className="mt-1 text-sm text-slate-600">Members: {team.memberNames.join(", ")}.</p>
        <p className="mt-2 text-sm text-slate-600">
          {cfg.name}: {cfg.durationMin} minutes in total, {Math.round((cfg.legSec / 60) * 10) / 10}{" "}
          minutes per member. Sit down in the order above and wait for the organiser to start.
        </p>
      </div>
    );
  } else if (cfg.status === "closed" || timeUp || finished) {
    body = (
      <>
        <div className={card}>
          <h2 className="font-semibold text-[#101828]">{team.name}</h2>
          <p className="mt-1 text-sm text-slate-700">
            {finished ? "Your team finished every question. " : "The round is over. "}
            Solved {team.solved} of {total}, with {team.wrong} wrong submits.
          </p>
        </div>
        {cfg.leaderboard && (
          <div className={card}>
            <h2 className="font-semibold text-[#101828]">Top teams</h2>
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-slate-500">
                <tr>
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">Team</th>
                  <th className="py-1 font-medium">Solved</th>
                  <th className="py-1 font-medium">Wrong</th>
                  <th className="py-1 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="text-slate-700">
                {cfg.leaderboard.map((r) => (
                  <tr key={r.rank} className="border-t border-slate-100">
                    <td className="py-1">{r.rank}</td>
                    <td className="py-1">{r.team}</td>
                    <td className="py-1">{r.solved}</td>
                    <td className="py-1">{r.wrong}</td>
                    <td className="py-1">{fmt(r.timeSec * 1000)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </>
    );
  } else if (!question) {
    body = <p className="text-sm text-slate-600">Loading your question…</p>;
  } else {
    const locked = phase !== "active" || handoff || busy === "submit" || busy === "check";
    body = (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <span className="font-semibold text-[#101828]">{team.name}</span>
          <span>
            Question {Math.min(team.qIndex + 1, total)} of {total}
          </span>
          <span>
            Solved {team.solved}, wrong submits {team.wrong}
          </span>
          <span className="font-semibold text-teal-700">Time left {fmt(endsAt - serverNow)}</span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-teal-700 bg-teal-50 px-4 py-3 text-sm text-slate-800">
          <span>
            Now coding: <b>{holderName}</b>. Turn ends in <b>{fmt(legMsLeft ?? 0)}</b>.
            {nMembers > 1 && (
              <>
                {" "}
                Next: <b>{nextName}</b>.
              </>
            )}
          </span>
          <span className="flex items-center gap-3">
            {passMsLeft !== null && passMsLeft > 0 && (
              <span className="text-xs text-slate-600">Early pass in {fmt(passMsLeft)}</span>
            )}
            <button
              className={btnGhost}
              onClick={onPass}
              disabled={!!busy || nMembers < 2 || (passMsLeft !== null && passMsLeft > 0)}
            >
              Pass the baton
            </button>
          </span>
        </div>

        {handoff && (
          <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
            Swap seats. {holderName} is up now. The editor opens in a few seconds.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className={card}>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                {TIER_LABEL[question.tier]}
              </span>
              <span className="rounded-full bg-teal-100 px-2 py-0.5 text-teal-900">
                {TYPE_LABEL[question.type]}
              </span>
            </div>
            <h2 className="mt-2 text-lg font-semibold text-[#101828]">{question.title}</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">{question.prompt}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-slate-500">Sample input</p>
                <pre className="mt-1 min-h-10 whitespace-pre-wrap rounded-md bg-slate-100 p-2 font-mono text-sm">
                  {question.sampleInput || "(none)"}
                </pre>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500">Expected output</p>
                <pre className="mt-1 min-h-10 whitespace-pre-wrap rounded-md bg-slate-100 p-2 font-mono text-sm">
                  {question.sampleOutput}
                </pre>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Your program is also tested on other, hidden values, so make it work for any valid input.
            </p>
          </div>

          <div className={card}>
            <textarea
              ref={taRef}
              value={code}
              onChange={(e) => setBoth(e.target.value)}
              onKeyDown={onEditorKey}
              readOnly={locked}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={14}
              className="w-full rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-sm leading-6 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
            <label className="mt-3 block text-xs font-medium text-slate-500">
              Test input for Run (starts as the sample, type any value you like)
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                rows={2}
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-slate-300 p-2 font-mono text-sm"
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={btnGhost} onClick={onRun} disabled={!!busy}>
                {busy === "run" ? "Running…" : "Run"}
              </button>
              <button className={btnGhost} onClick={onCheck} disabled={!!busy}>
                {busy === "check" ? "Checking…" : "Check tests"}
              </button>
              <button className={btn} onClick={onSubmit} disabled={!!busy}>
                {busy === "submit" ? "Submitting…" : "Submit"}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Run and Check tests are free and unlimited. Only Submit counts.
            </p>

            {runOut && (
              <div className="mt-3">
                <p className="text-xs font-medium text-slate-500">
                  Output
                  {runOut.sampleMatch === true && (
                    <span className="ml-2 text-teal-700">Matches the expected output</span>
                  )}
                  {runOut.sampleMatch === false && (
                    <span className="ml-2 text-red-700">Does not match the expected output</span>
                  )}
                </p>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-slate-900 p-2 font-mono text-sm text-slate-100">
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
              <div className="mt-3 rounded-md border border-slate-200 p-2 text-sm">
                <p className="font-medium text-slate-800">
                  {checkResults.every((r) => r.ok)
                    ? "All tests passed. You can submit."
                    : `${checkResults.filter((r) => r.ok).length} of ${checkResults.length} tests passed.`}
                </p>
                <ul className="mt-1">
                  {checkResults.map((r) => (
                    <li key={r.label} className={r.ok ? "text-teal-800" : "text-red-700"}>
                      {r.ok ? "Passed" : "Failed"}: {r.label}
                      {!r.ok && r.error ? ` (${r.error})` : ""}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-slate-500">
                  The other tests use hidden values, so their inputs are not shown.
                </p>
              </div>
            )}

            {notice && (
              <p
                role="status"
                className={`mt-3 rounded-md p-2 text-sm ${
                  notice.kind === "ok" ? "bg-teal-50 text-teal-900" : "bg-amber-50 text-amber-900"
                }`}
              >
                {notice.text}
              </p>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Code Relay" />
      <main className="mx-auto max-w-6xl space-y-4 p-4">
        <Link href="/students" className="text-sm text-teal-800 hover:underline">
          Back to events
        </Link>
        {body}
      </main>
    </div>
  );
}