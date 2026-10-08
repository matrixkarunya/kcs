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
  maxPerMember?: number;
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
  uid: string;
  username: string;
  memberNames: string[];
  solved: number;
  wrong: number;
  skipped: number;
  lastSolveMs: number;
  status: string;
}

/* ------------------------------- styles ------------------------------- */

const card = "rounded-2xl border border-slate-200 bg-white p-6 shadow-sm";
const btn =
  "rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50";
const btnDanger =
  "rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40";
const field =
  "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20";
const labelCls = "block text-xs font-semibold uppercase tracking-wide text-slate-500";

const STATUS_STYLE: Record<string, string> = {
  idle: "bg-slate-100 text-slate-700",
  lobby: "bg-amber-100 text-amber-800",
  running: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-200 text-slate-700",
  waiting: "bg-slate-100 text-slate-700",
  active: "bg-emerald-100 text-emerald-800",
  finished: "bg-teal-100 text-teal-800",
};
const TIER_STYLE = ["", "bg-emerald-100 text-emerald-800", "bg-amber-100 text-amber-800", "bg-red-100 text-red-800"];

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
      {text}
    </span>
  );
}

function SectionTitle({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-teal-700 text-sm font-bold text-white">
        {n}
      </span>
      <div>
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        {hint && <p className="mt-0.5 text-sm text-slate-500">{hint}</p>}
      </div>
    </div>
  );
}

/* ------------------------------- helpers ------------------------------- */

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

// Every score and progress field of a team, back to its starting value
const clearedScore = () => ({
  memberCounts: [] as number[],
  endedEarly: false,
  order: [] as string[],
  qIndex: 0,
  holder: 0,
  legStartedAt: null,
  solved: 0,
  wrong: 0,
  skipped: 0,
  bonusMs: 0,
  judgingSince: null,
  solvedIds: [] as string[],
  lastSolveAt: null,
  status: "waiting",
});

// One login per team. Member names are just the people's details.
const teamDoc = (name: string, login: Student, memberNames: string[]) => ({
  name,
  uid: login.id,
  username: login.username,
  memberNames,
  ...clearedScore(),
});

const trimEnd = (s: string) => s.replace(/\s+$/, "");
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// True when two members of the same team share a name (case-insensitive)
const hasDuplicateNames = (names: string[]) =>
  new Set(names.map((n) => n.toLowerCase())).size !== names.length;

/* -------------------------------- page -------------------------------- */

export default function AdminRelayPage() {
  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [students, setStudents] = useState<Student[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [bank, setBank] = useState<BankQuestion[] | null>(null);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "bad" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  // round settings
  const [name, setName] = useState("Relay 1");
  const [durationMin, setDurationMin] = useState(45);
  const [legSec, setLegSec] = useState(300);
  const [minPassSec, setMinPassSec] = useState(60);
  const [maxPerMember, setMaxPerMember] = useState(5);

  // teams
  const [bulk, setBulk] = useState("");
  const [teamName, setTeamName] = useState("");
  const [login, setLogin] = useState("");
  const [people, setPeople] = useState(["", "", ""]);

  // add question
  const [nq, setNq] = useState({
    title: "",
    tier: "1",
    type: "write",
    prompt: "",
    starterCode: "# Write your program below\n",
    sampleInput: "",
    hidden: "",
    solution: "",
  });

  const flash = (text: string, kind: "ok" | "bad" = "ok") => setMsg({ text, kind });
  const fail = (e: unknown) => flash((e as Error)?.message || "Something went wrong.", "bad");

  useEffect(
    () =>
      onSnapshot(doc(db, "config", "relay"), (s) =>
        setCfg(s.exists() ? (s.data() as Cfg) : null)
      ),
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
          uid: x.uid ?? "",
          username: x.username ?? "",
          memberNames: x.memberNames ?? [],
          solved: x.solved ?? 0,
          wrong: x.wrong ?? 0,
          skipped: x.skipped ?? 0,
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
  const freeLogins = useMemo(() => {
    const used = new Set(teams.map((t) => t.uid));
    return students.filter((s) => !used.has(s.id));
  }, [students, teams]);

  const readyCount = bank?.filter((q) => q.sampleOutput && q.hiddenOutputs?.length).length ?? 0;

  // ---------- round ----------
  async function createRound() {
    try {
      await setDoc(cfgRef, {
        roundId: `r${Date.now()}`,
        name: name.trim() || "Relay",
        status: "lobby",
        startedAt: null,
        durationMin: Math.max(1, durationMin),
        legSec: Math.max(30, legSec),
        minPassSec: Math.max(0, Math.min(minPassSec, legSec)),
        maxPerMember: Math.max(1, maxPerMember),
        leaderboard: null,
      });
      flash("New round created. Teams are in the lobby.");
    } catch (e) {
      fail(e);
    }
  }

  async function startRound() {
    if (!bank || bank.length === 0 || bank.some((q) => !q.sampleOutput || !q.hiddenOutputs?.length)) {
      return flash("Compute the question outputs first.", "bad");
    }
    if (teams.length === 0) return flash("Create teams first.", "bad");
    if (!window.confirm(`Start the round for ${teams.length} teams now?`)) return;
    try {
      const batch = writeBatch(db);
      for (const t of teams) {
        batch.update(doc(db, "relayTeams", t.id), {
          order: orderFor(bank),
          qIndex: 0,
          holder: 0,
          legStartedAt: serverTimestamp(),
          solved: 0,
          wrong: 0,
          skipped: 0,
          bonusMs: 0,
          judgingSince: null,
          solvedIds: [],
          lastSolveAt: null,
          memberCounts: t.memberNames.map(() => 0),
          endedEarly: false,
          status: "active",
        });
      }
      batch.update(cfgRef, { status: "running", startedAt: serverTimestamp() });
      await batch.commit();
      flash("Round started.");
      loadTeams();
    } catch (e) {
      fail(e);
    }
  }

  async function closeRound() {
    if (!window.confirm("Close the round for everyone?")) return;
    try {
      await updateDoc(cfgRef, { status: "closed" });
      flash("Round closed.");
    } catch (e) {
      fail(e);
    }
  }

  // ---------- reset scores ----------
  // Clears every team's score. The round goes back to the lobby with a new internal
  // id, so code saved on the team computers for the old round can't come back.
  async function resetAllScores() {
    if (teams.length === 0) return flash("There are no teams, so there are no scores to reset.", "bad");
    const live = status === "running";
    const ok = window.confirm(
      live
        ? "The round is running. This stops it, deletes every team's score and puts the round back in the lobby. This cannot be undone. Continue?"
        : "Delete every team's score and put the round back in the lobby? This cannot be undone."
    );
    if (!ok) return;
    try {
      const batch = writeBatch(db);
      for (const t of teams) batch.update(doc(db, "relayTeams", t.id), clearedScore());
      if (cfg?.roundId) {
        batch.update(cfgRef, {
          roundId: `r${Date.now()}`,
          status: "lobby",
          startedAt: null,
          leaderboard: null,
        });
      }
      await batch.commit();
      flash(
        cfg?.roundId
          ? `All scores deleted for ${teams.length} teams. The round is back in the lobby, press Start round when ready.`
          : `All scores deleted for ${teams.length} teams.`
      );
      loadTeams();
    } catch (e) {
      fail(e);
    }
  }

  // Clears one team. During a running round the team restarts from question 1.
  async function resetTeam(t: TeamRow) {
    const live = status === "running";
    const ok = window.confirm(
      live
        ? `Restart "${t.name}" from question 1 with a fresh question order? Their score is deleted.`
        : `Delete the score of "${t.name}"?`
    );
    if (!ok) return;
    try {
      if (live) {
        if (!bank || bank.length === 0) return flash("The question bank is empty.", "bad");
        await updateDoc(doc(db, "relayTeams", t.id), {
          ...clearedScore(),
          order: orderFor(bank),
          legStartedAt: serverTimestamp(),
          memberCounts: t.memberNames.map(() => 0),
          status: "active",
        });
      } else {
        await updateDoc(doc(db, "relayTeams", t.id), clearedScore());
      }
      flash(`"${t.name}" was reset.`);
      loadTeams();
    } catch (e) {
      fail(e);
    }
  }

  // ---------- teams ----------
  // One line per team:  Team name | Member 1, Member 2, Member 3
  async function bulkAdd() {
    const lines = bulk.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return flash("Paste at least one line.", "bad");
    if (lines.length > freeLogins.length) {
      return flash(`${lines.length} teams but only ${freeLogins.length} free logins.`, "bad");
    }
    try {
      const batch = writeBatch(db);
      for (let i = 0; i < lines.length; i++) {
        const [rawName, rawMembers = ""] = lines[i].split("|");
        const tName = rawName.trim();
        const memberNames = rawMembers.split(",").map((s) => s.trim()).filter(Boolean);
        if (!tName || memberNames.length === 0) {
          return flash(`Line ${i + 1}: use  Team name | Member 1, Member 2, Member 3`, "bad");
        }
        if (hasDuplicateNames(memberNames)) {
          return flash(`Line ${i + 1}: member names must be different.`, "bad");
        }
        batch.set(doc(collection(db, "relayTeams")), teamDoc(tName, freeLogins[i], memberNames));
      }
      await batch.commit();
      setBulk("");
      flash(`Added ${lines.length} teams. Each has its own login, shown in the list below.`);
      loadTeams();
    } catch (e) {
      fail(e);
    }
  }

  async function addTeam() {
    const memberNames = people.map((p) => p.trim()).filter(Boolean);
    const chosen = students.find((s) => s.id === login);
    if (!teamName.trim()) return flash("Give the team a name.", "bad");
    if (!chosen) return flash("Pick a login for the team.", "bad");
    if (memberNames.length === 0) return flash("Enter at least one member name.", "bad");
    if (hasDuplicateNames(memberNames)) {
      return flash("Member names in a team must be different.", "bad");
    }
    try {
      await setDoc(doc(collection(db, "relayTeams")), teamDoc(teamName.trim(), chosen, memberNames));
      setTeamName("");
      setLogin("");
      setPeople(["", "", ""]);
      flash("Team added.");
      loadTeams();
    } catch (e) {
      fail(e);
    }
  }

  async function removeTeam(t: TeamRow) {
    if (!window.confirm(`Remove team "${t.name}"?`)) return;
    try {
      await deleteDoc(doc(db, "relayTeams", t.id));
      setTeams((list) => list.filter((x) => x.id !== t.id));
    } catch (e) {
      fail(e);
    }
  }

  // ---------- bank ----------
  async function computeOutputs(qs: BankQuestion[]) {
    setBusy(true);
    try {
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
      if (errs.length) flash(`Some solutions failed: ${errs.join("; ")}`, "bad");
      else flash(`Computed outputs for ${out.length} questions.`);
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  }

  async function addQuestion() {
    const hiddenInputs = nq.hidden
      .split(/\n---\n/)
      .map((s) => s.replace(/^\n+|\n+$/g, ""))
      .filter((s) => s.length > 0);
    if (!nq.title.trim() || !nq.prompt.trim() || !nq.solution.trim() || hiddenInputs.length === 0) {
      return flash("Title, prompt, solution and at least one hidden input are required.", "bad");
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
          a.skipped - b.skipped ||
          (a.lastSolveMs || Number.MAX_SAFE_INTEGER) - (b.lastSolveMs || Number.MAX_SAFE_INTEGER)
      ),
    [teams]
  );
  const secs = (t: TeamRow) =>
    t.lastSolveMs && startMs ? Math.round((t.lastSolveMs - startMs) / 1000) : 0;

  async function publish() {
    try {
      await updateDoc(cfgRef, {
        leaderboard: ranked.slice(0, 5).map((t, i) => ({
          rank: i + 1,
          team: t.name,
          solved: t.solved,
          wrong: t.wrong,
          skipped: t.skipped,
          timeSec: secs(t),
        })),
      });
      flash("Top 5 published to students.");
    } catch (e) {
      fail(e);
    }
  }
  async function unpublish() {
    try {
      await updateDoc(cfgRef, { leaderboard: null });
      flash("Leaderboard hidden from students.");
    } catch (e) {
      fail(e);
    }
  }

  const medal = (i: number) =>
    i === 0 ? "bg-amber-400 text-white" : i === 1 ? "bg-slate-400 text-white" : i === 2 ? "bg-orange-400 text-white" : "bg-slate-100 text-slate-700";

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin: Code Relay" />
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        <div className="flex items-center justify-between">
          <Link href="/admin" className="text-sm font-medium text-teal-800 hover:underline">
            Back to admin
          </Link>
          {cfg?.roundId && <Pill text={`${cfg.name}: ${status}`} cls={STATUS_STYLE[status ?? "idle"]} />}
        </div>

        {msg && (
          <div
            role="status"
            className={`flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm font-medium ${
              msg.kind === "ok"
                ? "border-teal-200 bg-teal-50 text-teal-900"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            <span>{msg.text}</span>
            <button onClick={() => setMsg(null)} className="text-xs underline">
              Dismiss
            </button>
          </div>
        )}

        {/* summary tiles */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["Teams", teams.length],
            ["Free logins", freeLogins.length],
            ["Questions ready", `${readyCount}/${bank?.length ?? 0}`],
            ["Round", status ?? "none"],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{k}</p>
              <p className="mt-1 text-2xl font-bold capitalize text-slate-900">{v}</p>
            </div>
          ))}
        </div>

        {/* 1. ROUND */}
        <section className={card}>
          <SectionTitle
            n={1}
            title="Round"
            hint="Creating a round keeps your teams. Starting it gives every team its own shuffled question order and starts the clocks."
          />
          {cfg?.roundId && (
            <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <b>{cfg.name}</b>: {cfg.durationMin} min total, {cfg.legSec}s per member, early pass
              after {cfg.minPassSec}s, max {cfg.maxPerMember ?? 5} questions per member.
            </p>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <label className={labelCls}>
              Name
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={labelCls}>
              Total minutes
              <input type="number" className={field} value={durationMin} onChange={(e) => setDurationMin(Number(e.target.value))} />
            </label>
            <label className={labelCls}>
              Seconds per member
              <input type="number" className={field} value={legSec} onChange={(e) => setLegSec(Number(e.target.value))} />
            </label>
            <label className={labelCls}>
              Min seconds before early pass
              <input type="number" className={field} value={minPassSec} onChange={(e) => setMinPassSec(Number(e.target.value))} />
            </label>
            <label className={labelCls}>
              Max questions per member
              <input type="number" className={field} value={maxPerMember} onChange={(e) => setMaxPerMember(Number(e.target.value))} />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <button className={btnGhost} onClick={createRound}>Create new round</button>
            <button className={btn} disabled={status !== "lobby"} onClick={startRound}>Start round</button>
            <button className={btnDanger} disabled={status !== "running"} onClick={closeRound}>Close round</button>
          </div>
        </section>

        {/* 2. TEAMS */}
        <section className={card}>
          <SectionTitle
            n={2}
            title={`Teams (${teams.length})`}
            hint="Each team plays on one login and one computer. Member names are shown on the team's screen."
          />

          <div className="mt-5 grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-800">Add many teams</p>
              <p className="text-xs text-slate-500">One per line: Team name | Member 1, Member 2, Member 3</p>
              <textarea
                rows={5}
                className={`${field} font-mono`}
                value={bulk}
                onChange={(e) => setBulk(e.target.value)}
                placeholder={"Team Alpha | Ravi, Meena, Zoe\nTeam Beta | Asha, Kiran, Dev"}
              />
              <button className={`${btn} mt-3`} onClick={bulkAdd}>Add teams (next free logins)</button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-800">Add one team</p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label className={labelCls}>
                  Team name
                  <input className={field} value={teamName} onChange={(e) => setTeamName(e.target.value)} />
                </label>
                <label className={labelCls}>
                  Login
                  <select className={field} value={login} onChange={(e) => setLogin(e.target.value)}>
                    <option value="">(choose)</option>
                    {freeLogins.map((s) => (
                      <option key={s.id} value={s.id}>{s.username}</option>
                    ))}
                  </select>
                </label>
                {people.map((p, i) => (
                  <label key={i} className={labelCls}>
                    Member {i + 1}
                    <input
                      className={field}
                      value={p}
                      onChange={(e) => setPeople((ps) => ps.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                  </label>
                ))}
              </div>
              <button className={`${btn} mt-3`} onClick={addTeam}>Add one team</button>
            </div>
          </div>

          <ul className="mt-6 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {teams.length === 0 && (
              <li className="p-4 text-sm text-slate-500">No teams yet.</li>
            )}
            {teams.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-teal-100 text-sm font-bold text-teal-800">
                    {t.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {t.name}{" "}
                      <code className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-700">
                        {t.username || "old format, remove it"}
                      </code>
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {t.memberNames.map((m, i) => (
                        <span
                          key={`${i}-${m}`}
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
                <button className={btnDanger} onClick={() => removeTeam(t)} disabled={status === "running"}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* 3. RESULTS */}
        <section className={card}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle
              n={3}
              title="Results"
              hint="Not live, to keep Firebase usage low. Press Refresh. Ranked by solved, then fewest wrong submits, then fewest skips, then earliest last solve."
            />
            <div className="flex flex-wrap gap-2">
              <button className={btnGhost} onClick={loadTeams}>Refresh</button>
              <button className={btn} onClick={publish} disabled={ranked.length === 0}>Publish top 5</button>
              <button className={btnGhost} onClick={unpublish} disabled={!cfg?.leaderboard}>Unpublish</button>
              <button className={btnDanger} onClick={resetAllScores} disabled={teams.length === 0}>
                Reset all scores
              </button>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Reset all scores deletes every team's score and puts the round back in the lobby. The Reset
            button on a row clears just that team (if the round is running, the team restarts from
            question 1; code they already typed on their computer may reappear).
          </p>
          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Team</th>
                  <th className="px-3 py-2 font-semibold">Login</th>
                  <th className="px-3 py-2 font-semibold">Solved</th>
                  <th className="px-3 py-2 font-semibold">Wrong</th>
                  <th className="px-3 py-2 font-semibold">Skipped</th>
                  <th className="px-3 py-2 font-semibold">Last solve</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="text-slate-800">
                {ranked.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-4 text-slate-500">No teams yet.</td>
                  </tr>
                )}
                {ranked.map((t, i) => (
                  <tr key={t.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${medal(i)}`}>
                        {i + 1}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-semibold">{t.name}</td>
                    <td className="px-3 py-2 text-slate-600">{t.username}</td>
                    <td className="px-3 py-2 font-semibold text-teal-700">{t.solved}</td>
                    <td className="px-3 py-2 text-red-700">{t.wrong}</td>
                    <td className="px-3 py-2">{t.skipped}</td>
                    <td className="px-3 py-2 font-mono">{t.lastSolveMs ? mmss(secs(t)) : "-"}</td>
                    <td className="px-3 py-2">
                      <Pill text={t.status} cls={STATUS_STYLE[t.status] ?? STATUS_STYLE.waiting} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button className={btnDanger} onClick={() => resetTeam(t)}>Reset</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cfg?.leaderboard && (
            <p className="mt-3 text-xs font-medium text-teal-800">The top 5 is currently visible to students.</p>
          )}
        </section>

        {/* 4. BANK */}
        <section className={card}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle
              n={4}
              title={`Question bank${bank ? ` (${bank.length})` : ""}`}
              hint="Expected outputs come from each reference solution. Open a question to check its inputs and outputs before the event."
            />
            <button className={btn} disabled={busy || !bank?.length} onClick={() => bank && computeOutputs(bank)}>
              {busy ? "Working…" : "Compute outputs"}
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {bank?.map((q) => {
              const ready = !!q.sampleOutput && q.hiddenOutputs.length > 0;
              return (
                <details key={q.id} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">{q.id}</span>
                    <span className="font-semibold">{q.title}</span>
                    <Pill text={TIER_LABEL[q.tier]} cls={TIER_STYLE[q.tier]} />
                    <Pill text={TYPE_LABEL[q.type]} cls="bg-slate-100 text-slate-700" />
                    <span className="flex-1" />
                    <Pill
                      text={ready ? "ready" : "outputs missing"}
                      cls={ready ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"}
                    />
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <pre className="whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">{`Sample input:\n${q.sampleInput}\n\nSample output:\n${q.sampleOutput}`}</pre>
                    <pre className="whitespace-pre-wrap rounded-lg bg-slate-900 p-3 font-mono text-xs text-slate-100">
                      {q.hiddenInputs
                        .map((h, i) => `Hidden ${i + 1} input:\n${h}\nOutput:\n${q.hiddenOutputs[i] ?? "(not computed)"}`)
                        .join("\n\n")}
                    </pre>
                  </div>
                </details>
              );
            })}
            {bank && bank.length === 0 && <p className="text-sm text-slate-500">The bank is empty.</p>}
          </div>

          <div className="mt-6 border-t border-slate-100 pt-5">
            <button className={btnGhost} onClick={() => setShowAdd((v) => !v)}>
              {showAdd ? "Hide the add question form" : "Add a question"}
            </button>

            {showAdd && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className={labelCls}>
                  Title
                  <input className={field} value={nq.title} onChange={(e) => setNq({ ...nq, title: e.target.value })} />
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className={labelCls}>
                    Tier
                    <select className={field} value={nq.tier} onChange={(e) => setNq({ ...nq, tier: e.target.value })}>
                      <option value="1">Easy</option>
                      <option value="2">Medium</option>
                      <option value="3">Hard</option>
                    </select>
                  </label>
                  <label className={labelCls}>
                    Type
                    <select className={field} value={nq.type} onChange={(e) => setNq({ ...nq, type: e.target.value })}>
                      <option value="write">Write</option>
                      <option value="fix">Fix the bug</option>
                      <option value="complete">Complete</option>
                    </select>
                  </label>
                </div>
                <label className={`${labelCls} sm:col-span-2`}>
                  Prompt
                  <textarea rows={3} className={field} value={nq.prompt} onChange={(e) => setNq({ ...nq, prompt: e.target.value })} />
                </label>
                <label className={labelCls}>
                  Starter code (buggy or with blanks)
                  <textarea rows={6} className={`${field} font-mono`} value={nq.starterCode} onChange={(e) => setNq({ ...nq, starterCode: e.target.value })} />
                </label>
                <label className={labelCls}>
                  Reference solution
                  <textarea rows={6} className={`${field} font-mono`} value={nq.solution} onChange={(e) => setNq({ ...nq, solution: e.target.value })} />
                </label>
                <label className={labelCls}>
                  Sample input (shown to students)
                  <textarea rows={3} className={`${field} font-mono`} value={nq.sampleInput} onChange={(e) => setNq({ ...nq, sampleInput: e.target.value })} />
                </label>
                <label className={labelCls}>
                  Hidden inputs (separate each with a line containing only ---)
                  <textarea rows={3} className={`${field} font-mono`} value={nq.hidden} onChange={(e) => setNq({ ...nq, hidden: e.target.value })} />
                </label>
                <div className="sm:col-span-2">
                  <button className={btn} disabled={busy} onClick={addQuestion}>
                    {busy ? "Working…" : "Add question and compute outputs"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}