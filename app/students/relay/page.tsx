"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
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
  memberUids: string[];
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
  const [runOut, setRunOut] = useState<{ output: string; error: string | null } | null>(null);
  const [busy, setBusy] = useState<"" | "run" | "submit" | "pass">("");
  const [notice, setNotice] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [retry, setRetry] = useState(0);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef("");
  const lastSaved = useRef("");
  const passedFor = useRef(0);
  const ctx = useRef({ teamId: null as string | null | undefined, qid: "", roundId: "", isHolder: false });

  const running = cfg?.status === "running";
  const isHolder = !!team && !!uid && team.memberUids[team.holder] === uid;

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

  useEffect(() => {
    if (!uid) return;
    getDocs(query(collection(db, "relayTeams"), where("memberUids", "array-contains", uid)))
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
  const myIndex = team && uid ? team.memberUids.indexOf(uid) : -1;

  // ---------- current question ----------
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
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [arena, teamId, team?.qIndex, cfg?.roundId]);

  useEffect(() => {
    ctx.current = {
      teamId,
      qid: question?.id ?? "",
      roundId: cfg?.roundId ?? "",
      isHolder,
    };
  }, [teamId, question, cfg?.roundId, isHolder]);

  // when it becomes my turn (or the question changes), load the team's latest code
  useEffect(() => {
    if (!question || !teamId || !isHolder) return;
    let alive = true;
    const key = `${cfg?.roundId}_${question.id}`;
    const apply = (c: string) => {
      if (!alive) return;
      setCode(c);
      codeRef.current = c;
      lastSaved.current = c;
    };
    getDoc(doc(db, "relayCode", teamId))
      .then((s) =>
        apply(s.exists() && s.data().key === key ? (s.data().code as string) : question.starterCode)
      )
      .catch(() => apply(question.starterCode));
    return () => {
      alive = false;
    };
  }, [question, isHolder, teamId, cfg?.roundId]);

  const flush = useCallback(async () => {
    const c = ctx.current;
    if (!c.teamId || !c.qid || !c.isHolder) return;
    const text = codeRef.current;
    if (text === lastSaved.current) return;
    await setDoc(doc(db, "relayCode", c.teamId), {
      code: text,
      key: `${c.roundId}_${c.qid}`,
      at: serverTimestamp(),
    });
    lastSaved.current = text;
  }, []);

  // checkpoint every 10 seconds while it is my turn
  useEffect(() => {
    if (!isHolder || !question) return;
    const id = setInterval(() => {
      flush().catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [isHolder, question, flush]);

  // automatic baton pass when the leg time runs out
  useEffect(() => {
    if (!expired || !teamId || !arena || legStartMs === 0) return;
    if (passedFor.current === legStartMs) return;
    passedFor.current = legStartMs;
    const delay = isHolder ? 0 : 1500 + Math.random() * 1000;
    const t = setTimeout(async () => {
      try {
        if (isHolder) await flush();
        await api("/api/relay", { action: "pass", mode: "timeout", teamId });
      } catch {
        setTimeout(() => {
          passedFor.current = 0;
          setRetry((n) => n + 1);
        }, 3000);
      }
    }, delay);
    return () => clearTimeout(t);
  }, [expired, legStartMs, teamId, arena, isHolder, flush, retry]);

  // ---------- editor ----------
  function setBoth(next: string) {
    codeRef.current = next;
    setCode(next);
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
  async function onRun() {
    if (busy) return;
    setBusy("run");
    setRunOut(null);
    const [r] = await runPython(code, [inputText], 8000);
    setRunOut({ output: r.output, error: r.error });
    setBusy("");
  }

  async function onSubmit() {
    if (busy || !question || !teamId) return;
    setBusy("submit");
    setNotice(null);
    try {
      await flush();
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
      if (res.ok) {
        setNotice({
          kind: "ok",
          text: res.finished
            ? "Correct! Your team has finished every question."
            : "Correct! Here is the next question.",
        });
      } else {
        const sampleOk =
          normalizeOutput(results[0].output) === normalizeOutput(question.sampleOutput);
        setNotice({
          kind: "bad",
          text: sampleOk
            ? "Your code matches the sample, but it is not correct for every valid input. Re-read the question and try your own values in the test input box."
            : "Not correct yet. Compare your output with the expected output and try again.",
        });
      }
    } catch (e) {
      const m = (e as Error).message;
      setNotice({
        kind: "bad",
        text:
          m === "not-holder"
            ? "It is not your turn any more."
            : m === "time-up"
            ? "Time is up."
            : "Could not submit. Check the connection and try again.",
      });
    }
    setBusy("");
  }

  async function onPass() {
    if (busy || !teamId) return;
    setBusy("pass");
    try {
      await flush();
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
    body = (
      <div className={card}>
        You are not in a team for Code Relay. Tell an organiser.
      </div>
    );
  } else if (!cfg || cfg.status === "idle") {
    body = <div className={card}>No relay round is open yet. Wait for the organiser.</div>;
  } else if (cfg.status === "lobby") {
    body = (
      <div className={card}>
        <h2 className="font-semibold text-[#101828]">{team.name}</h2>
        <p className="mt-1 text-sm text-slate-600">
          Team members: {team.memberNames.join(", ")}.
        </p>
        <p className="mt-2 text-sm text-slate-600">
          {cfg.name}: {cfg.durationMin} minutes in total, {Math.round(cfg.legSec / 60 * 10) / 10}{" "}
          minutes per member. Wait for the organiser to start.
        </p>
      </div>
    );
  } else if (cfg.status === "closed" || timeUp || finished) {
    body = (
      <>
        <div className={card}>
          <h2 className="font-semibold text-[#101828]">{team.name}</h2>
          <p className="mt-1 text-sm text-slate-700">
            {finished ? "Your team finished every question. " : timeUp || cfg.status === "closed" ? "The round is over. " : ""}
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
    const n = team.memberUids.length;
    const holderName = team.memberNames[team.holder];
    const turnsAway = myIndex >= 0 ? (myIndex - team.holder + n) % n : 0;
    const myTurnIn = (legMsLeft ?? 0) + Math.max(0, turnsAway - 1) * (cfg.legSec * 1000);
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

        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            isHolder ? "border-teal-700 bg-teal-50 text-slate-800" : "border-slate-200 bg-white text-slate-700"
          }`}
        >
          {isHolder ? (
            <>
              <b>Your turn.</b> Your leg ends in <b>{fmt(legMsLeft ?? 0)}</b>.{" "}
              {passMsLeft !== null && passMsLeft > 0
                ? `You can pass the baton in ${fmt(passMsLeft)}.`
                : "You can pass the baton now."}
            </>
          ) : (
            <>
              <b>{holderName}</b> is coding. Your turn comes in about <b>{fmt(myTurnIn)}</b> (sooner
              if they pass early). The code stays hidden until your turn.
            </>
          )}
        </div>

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
              Your program is checked on more inputs than the sample, so make it work for any
              valid value.
            </p>
          </div>

          <div className={card}>
            {isHolder ? (
              <>
                <textarea
                  ref={taRef}
                  value={code}
                  onChange={(e) => setBoth(e.target.value)}
                  onKeyDown={onEditorKey}
                  readOnly={phase !== "active" || busy === "submit"}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  rows={14}
                  className="w-full rounded-md border border-slate-300 bg-slate-50 p-3 font-mono text-sm leading-6 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
                />
                <label className="mt-3 block text-xs font-medium text-slate-500">
                  Test input (change it to try your own values)
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
                  <button className={btn} onClick={onSubmit} disabled={!!busy}>
                    {busy === "submit" ? "Checking…" : "Submit"}
                  </button>
                  <button
                    className={btnGhost}
                    onClick={onPass}
                    disabled={!!busy || (passMsLeft !== null && passMsLeft > 0)}
                  >
                    Pass the baton
                  </button>
                </div>
                {runOut && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-slate-500">Output</p>
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
              </>
            ) : (
              <p className="text-sm text-slate-600">
                Read the question and plan with your team. The editor opens for you when {holderName}{" "}
                passes the baton or their time ends.
              </p>
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