"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import AppHeader from "@/components/app-header";
import { runPython } from "@/lib/py-runner";
import { BankQuestion, QType, Tier, TIER_LABEL, TYPE_LABEL } from "@/lib/relay";

interface Cfg {
  roundId: string | null;
  name: string;
  status: "idle" | "lobby" | "running" | "closed";
  startedAt: Timestamp | null;
  durationMin: number;
  legSec: number;
  minPassSec: number;
  leaderboard: unknown[] | null;
}
interface Student {
  id: string;
  username: string;
  name: string;
}
interface TeamRow {
  id: string;
  name: string;
  memberUids: string[];
  memberNames: string[];
  memberUsernames: string[];
  solved: number;
  wrong: number;
  lastSolveMs: number;
  status: string;
}

const card = "rounded-xl border border-slate-200 bg-white p-5";
const btn =
  "rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50";
const btnGhost =
  "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50";
const field = "mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const orderFor = (qs: BankQuestion[]) =>
  [1, 2, 3].flatMap((t) => shuffle(qs.filter((q) => q.tier === t)).map((q) => q.id));

const newTeamDoc = (name: string, members: Student[]) => ({
  name,
  memberUids: members.map((m) => m.id),
  memberNames: members.map((m) => m.name),
  memberUsernames: members.map((m) => m.username),
  order: [],
  qIndex: 0,
  holder: 0,
  legStartedAt: null,
  solved: 0,
  wrong: 0,
  solvedIds: [],
  lastSolveAt: null,
  status: "waiting",
});

const trimEnd = (s: string) => s.replace(/\s+$/, "");

export default function AdminRelayPage() {
  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [students, setStudents] = useState<Student[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [bank, setBank] = useState<BankQuestion[] | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // round settings
  const [name, setName] = useState("Relay 1");
  const [durationMin, setDurationMin] = useState(45);
  const [legSec, setLegSec] = useState(300);
  const [minPassSec, setMinPassSec] = useState(60);

  // manual team
  const [teamName, setTeamName] = useState("");
  const [members, setMembers] = useState(["", "", ""]);

  // add question
  const [nq, setNq] = useState({
    title: "", tier: "1", type: "write", prompt: "", starterCode: "# Write your program below\n",
    sampleInput: "", hidden: "", solution: "",
  });

  useEffect(
    () => onSnapshot(doc(db, "config", "relay"), (s) => setCfg(s.exists() ? (s.data() as Cfg) : null)),
    []
  );

  const loadTeams = useCallback(async () => {
    const snap = await getDocs(collection(db, "relayTeams"));
    setTeams(
      snap.docs.map((d) => {
        const x = d.data();
        return {
          id: d.id,
          name: x.name,
          memberUids: x.memberUids,
          memberNames: x.memberNames,
          memberUsernames: x.memberUsernames,
          solved: x.solved ?? 0,
          wrong: x.wrong ?? 0,
          lastSolveMs: x.lastSolveAt?.toMillis?.() ?? 0,
          status: x.status,
        } as TeamRow;
      })
    );
  }, []);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "==", "student"))).then((s) => {
      const rows = s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Student, "id">) }));
      rows.sort((a, b) => a.username.localeCompare(b.username));
      setStudents(rows);
    });
    loadTeams();
    getDoc(doc(db, "config", "relayBank")).then((s) =>
      setBank((s.data()?.questions ?? []) as BankQuestion[])
    );
  }, [loadTeams]);

  const cfgRef = doc(db, "config", "relay");
  const status = cfg?.status;

  // ---------- round ----------
  const createRound = () =>
    setDoc(cfgRef, {
      roundId: `r${Date.now()}`,
      name: name.trim() || "Relay",
      status: "lobby",
      startedAt: null,
      durationMin: Math.max(1, durationMin),
      legSec: Math.max(30, legSec),
      minPassSec: Math.max(0, Math.min(minPassSec, legSec)),
      leaderboard: null,
    });

  async function startRound() {
    if (!bank || bank.length === 0 || bank.some((q) => !q.sampleOutput || !q.hiddenOutputs?.length)) {
      setMsg("Compute the question outputs first.");
      return;
    }
    if (teams.length === 0) {
      setMsg("Create teams first.");
      return;
    }
    const batch = writeBatch(db);
    for (const t of teams) {
      batch.update(doc(db, "relayTeams", t.id), {
        order: orderFor(bank),
        qIndex: 0,
        holder: 0,
        legStartedAt: serverTimestamp(),
        solved: 0,
        wrong: 0,
        solvedIds: [],
        lastSolveAt: null,
        status: "active",
      });
    }
    batch.update(cfgRef, { status: "running", startedAt: serverTimestamp() });
    await batch.commit();
    setMsg("Round started.");
    loadTeams();
  }

  const closeRound = () => updateDoc(cfgRef, { status: "closed" });

  // ---------- teams ----------
  async function addTeam() {
    const picked = members.filter(Boolean);
    const chosen = students.filter((s) => picked.includes(s.id));
    const used = new Set(teams.flatMap((t) => t.memberUids));
    if (!teamName.trim()) return setMsg("Give the team a name.");
    if (new Set(picked).size !== picked.length || chosen.length < 2) {
      return setMsg("Pick at least 2 different members.");
    }
    if (chosen.some((s) => used.has(s.id))) return setMsg("A member is already in another team.");
    await setDoc(doc(collection(db, "relayTeams")), newTeamDoc(teamName.trim(), chosen));
    setTeamName("");
    setMembers(["", "", ""]);
    setMsg("Team added.");
    loadTeams();
  }

  async function autoTeams() {
    const used = new Set(teams.flatMap((t) => t.memberUids));
    const free = shuffle(students.filter((s) => !used.has(s.id)));
    if (free.length === 0) return setMsg("Every student is already in a team.");
    const batch = writeBatch(db);
    let n = teams.length;
    for (let i = 0; i < free.length; i += 3) {
      batch.set(doc(collection(db, "relayTeams")), newTeamDoc(`Team ${++n}`, free.slice(i, i + 3)));
    }
    await batch.commit();
    setMsg(`Created ${Math.ceil(free.length / 3)} teams. The last one may have fewer than 3 members.`);
    loadTeams();
  }

  async function removeTeam(id: string) {
    await deleteDoc(doc(db, "relayTeams", id));
    setTeams((t) => t.filter((x) => x.id !== id));
  }

  // ---------- bank ----------
  async function computeOutputs(qs: BankQuestion[]) {
    setBusy(true);
    const out: BankQuestion[] = [];
    const errs: string[] = [];
    for (const q of qs) {
      const res = await runPython(q.solution, [q.sampleInput, ...q.hiddenInputs], 10000);
      const bad = res.find((r) => r.error);
      if (bad) {
        errs.push(`${q.id}: ${bad.error}`);
        out.push(q);
        continue;
      }
      out.push({
        ...q,
        sampleOutput: trimEnd(res[0].output),
        hiddenOutputs: res.slice(1).map((r) => trimEnd(r.output)),
      });
    }
    await setDoc(doc(db, "config", "relayBank"), { questions: out });
    setBank(out);
    setMsg(errs.length ? `Some solutions failed: ${errs.join("; ")}` : `Computed outputs for ${out.length} questions.`);
    setBusy(false);
  }

  async function addQuestion() {
    const hiddenInputs = nq.hidden
      .split(/\n---\n/)
      .map((s) => s.replace(/^\n+|\n+$/g, ""))
      .filter((s) => s.length > 0);
    if (!nq.title.trim() || !nq.prompt.trim() || !nq.solution.trim() || hiddenInputs.length === 0) {
      return setMsg("Title, prompt, solution and at least one hidden input are required.");
    }
    const list = bank ?? [];
    const id = `q${String(list.length + 1).padStart(2, "0")}x${Date.now() % 1000}`;
    const q: BankQuestion = {
      id,
      tier: Number(nq.tier) as Tier,
      type: nq.type as QType,
      title: nq.title.trim(),
      prompt: nq.prompt.trim(),
      starterCode: nq.starterCode,
      sampleInput: nq.sampleInput,
      sampleOutput: "",
      hiddenInputs,
      hiddenOutputs: [],
      solution: nq.solution,
    };
    await computeOutputs([...list, q]);
  }

  // ---------- results ----------
  const startMs = cfg?.startedAt?.toMillis() ?? 0;
  const ranked = useMemo(
    () =>
      [...teams].sort(
        (a, b) =>
          b.solved - a.solved ||
          a.wrong - b.wrong ||
          (a.lastSolveMs || Number.MAX_SAFE_INTEGER) - (b.lastSolveMs || Number.MAX_SAFE_INTEGER)
      ),
    [teams]
  );
  const secs = (t: TeamRow) => (t.lastSolveMs && startMs ? Math.round((t.lastSolveMs - startMs) / 1000) : 0);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const publish = () =>
    updateDoc(cfgRef, {
      leaderboard: ranked.slice(0, 5).map((t, i) => ({
        rank: i + 1,
        team: t.name,
        solved: t.solved,
        wrong: t.wrong,
        timeSec: secs(t),
      })),
    });

  const unassigned = students.length - new Set(teams.flatMap((t) => t.memberUids)).size;

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin: Code Relay" />
      <main className="mx-auto max-w-5xl space-y-6 p-6">
        <Link href="/admin" className="text-sm text-teal-800 hover:underline">
          Back to admin
        </Link>
        {msg && <p className="rounded-md bg-teal-50 p-2 text-sm text-teal-900">{msg}</p>}

        {/* ROUND */}
        <section className={card}>
          <h2 className="font-semibold text-[#101828]">Round</h2>
          <p className="mt-2 text-sm text-slate-700">
            {cfg && cfg.roundId
              ? `${cfg.name}: ${status} (${cfg.durationMin} min total, ${cfg.legSec}s per member, early pass after ${cfg.minPassSec}s)`
              : "No round yet."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-700">Name
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="text-sm text-slate-700">Total minutes
              <input type="number" className={`${field} w-24`} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
            </label>
            <label className="text-sm text-slate-700">Seconds per member
              <input type="number" className={`${field} w-24`} value={legSec} onChange={(e) => setLegSec(Number(e.target.value))} />
            </label>
            <label className="text-sm text-slate-700">Min seconds before early pass
              <input type="number" className={`${field} w-24`} value={minPassSec} onChange={(e) => setMinPassSec(Number(e.target.value))} />
            </label>
            <button className={btn} onClick={createRound}>Create new round</button>
          </div>
          <div className="mt-4 flex gap-3">
            <button className={btn} disabled={status !== "lobby"} onClick={startRound}>Start round</button>
            <button className={btnGhost} disabled={status !== "running"} onClick={closeRound}>Close round</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Start gives every team its own shuffled question order and starts the clocks. Creating a round
            keeps your teams.
          </p>
        </section>

        {/* TEAMS */}
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[#101828]">Teams ({teams.length}), {unassigned} students not in a team</h2>
            <button className={btnGhost} onClick={autoTeams} disabled={unassigned === 0}>
              Auto-create teams of 3
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-700">Team name
              <input className={field} value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            </label>
            {members.map((m, i) => (
              <label key={i} className="text-sm text-slate-700">Member {i + 1}
                <select
                  className={field}
                  value={m}
                  onChange={(e) => setMembers((ms) => ms.map((x, j) => (j === i ? e.target.value : x)))}
                >
                  <option value="">(none)</option>
                  {students.map((s) => (
                    <option key={s.id} value={s.id}>{s.username}</option>
                  ))}
                </select>
              </label>
            ))}
            <button className={btn} onClick={addTeam}>Add team</button>
          </div>
          <ul className="mt-4 space-y-1 text-sm text-slate-700">
            {teams.map((t) => (
              <li key={t.id} className="flex items-center justify-between border-t border-slate-100 py-1">
                <span><b>{t.name}</b>: {t.memberUsernames.join(", ")}</span>
                <button className={btnGhost} onClick={() => removeTeam(t.id)} disabled={status === "running"}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* RESULTS */}
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[#101828]">Results</h2>
            <div className="flex gap-2">
              <button className={btnGhost} onClick={loadTeams}>Refresh</button>
              <button className={btn} onClick={publish} disabled={ranked.length === 0}>Publish top 5</button>
              <button className={btnGhost} onClick={() => updateDoc(cfgRef, { leaderboard: null })} disabled={!cfg?.leaderboard}>
                Unpublish
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Not live, to keep Firebase usage low. Press Refresh. Ranked by solved, then fewest wrong
            submits, then earliest last solve.
          </p>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 font-medium">#</th>
                <th className="py-1 font-medium">Team</th>
                <th className="py-1 font-medium">Solved</th>
                <th className="py-1 font-medium">Wrong</th>
                <th className="py-1 font-medium">Last solve</th>
                <th className="py-1 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="text-slate-700">
              {ranked.map((t, i) => (
                <tr key={t.id} className="border-t border-slate-100">
                  <td className="py-1">{i + 1}</td>
                  <td className="py-1">{t.name}</td>
                  <td className="py-1">{t.solved}</td>
                  <td className="py-1">{t.wrong}</td>
                  <td className="py-1">{t.lastSolveMs ? mmss(secs(t)) : "-"}</td>
                  <td className="py-1">{t.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* BANK */}
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[#101828]">Question bank {bank && `(${bank.length})`}</h2>
            <button className={btn} disabled={busy || !bank?.length} onClick={() => bank && computeOutputs(bank)}>
              {busy ? "Working…" : "Compute outputs"}
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Expected outputs come from each reference solution. Open a question to check its sample and
            hidden inputs and outputs before the event.
          </p>
          <div className="mt-3 space-y-1">
            {bank?.map((q) => (
              <details key={q.id} className="rounded-md border border-slate-100 px-2 py-1 text-sm text-slate-700">
                <summary className="cursor-pointer">
                  {q.id}: {q.title} ({TIER_LABEL[q.tier]}, {TYPE_LABEL[q.type]}){" "}
                  {q.sampleOutput && q.hiddenOutputs.length ? "ready" : "outputs missing"}
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs">{`Sample input:\n${q.sampleInput}\n\nSample output:\n${q.sampleOutput}`}</pre>
                  <pre className="whitespace-pre-wrap rounded bg-slate-100 p-2 text-xs">
                    {q.hiddenInputs.map((h, i) => `Hidden ${i + 1} input:\n${h}\nOutput:\n${q.hiddenOutputs[i] ?? "(not computed)"}`).join("\n\n")}
                  </pre>
                </div>
              </details>
            ))}
          </div>

          <h3 className="mt-5 text-sm font-semibold text-[#101828]">Add a question</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-sm text-slate-700">Title
              <input className={`${field} w-full`} value={nq.title} onChange={(e) => setNq({ ...nq, title: e.target.value })} />
            </label>
            <div className="flex gap-2">
              <label className="text-sm text-slate-700">Tier
                <select className={field} value={nq.tier} onChange={(e) => setNq({ ...nq, tier: e.target.value })}>
                  <option value="1">Easy</option><option value="2">Medium</option><option value="3">Hard</option>
                </select>
              </label>
              <label className="text-sm text-slate-700">Type
                <select className={field} value={nq.type} onChange={(e) => setNq({ ...nq, type: e.target.value })}>
                  <option value="write">Write</option><option value="fix">Fix the bug</option><option value="complete">Complete</option>
                </select>
              </label>
            </div>
            <label className="text-sm text-slate-700 sm:col-span-2">Prompt
              <textarea rows={3} className={`${field} w-full`} value={nq.prompt} onChange={(e) => setNq({ ...nq, prompt: e.target.value })} />
            </label>
            <label className="text-sm text-slate-700">Starter code (buggy or with blanks)
              <textarea rows={5} className={`${field} w-full font-mono`} value={nq.starterCode} onChange={(e) => setNq({ ...nq, starterCode: e.target.value })} />
            </label>
            <label className="text-sm text-slate-700">Reference solution
              <textarea rows={5} className={`${field} w-full font-mono`} value={nq.solution} onChange={(e) => setNq({ ...nq, solution: e.target.value })} />
            </label>
            <label className="text-sm text-slate-700">Sample input (shown to students)
              <textarea rows={2} className={`${field} w-full font-mono`} value={nq.sampleInput} onChange={(e) => setNq({ ...nq, sampleInput: e.target.value })} />
            </label>
            <label className="text-sm text-slate-700">Hidden inputs (separate each with a line containing only ---)
              <textarea rows={4} className={`${field} w-full font-mono`} value={nq.hidden} onChange={(e) => setNq({ ...nq, hidden: e.target.value })} />
            </label>
          </div>
          <button className={`${btn} mt-3`} disabled={busy} onClick={addQuestion}>Add question</button>
        </section>
      </main>
    </div>
  );
}