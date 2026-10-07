"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type DocumentData,
  type WriteBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import AppHeader from "@/components/app-header";
import { LeaderRow, Mistake, RoundStatus } from "@/lib/typing";

interface Cfg {
  roundId: string | null;
  name: string;
  durationSec: number;
  status: RoundStatus;
  startedAt: Timestamp | null;
  leaderboard: LeaderRow[] | null;
}
interface Round {
  id: string;
  name: string;
  durationSec: number;
  status: RoundStatus;
  createdMs: number;
  startedMs: number;
  closedMs: number;
  leaderboard: LeaderRow[] | null;
}
type Review = "valid" | "flagged" | "cleared" | "disqualified";
interface Row {
  id: string;
  roundId: string;
  uid: string;
  username: string;
  name: string;
  status: "started" | "submitted";
  review?: Review;
  flags: string[];
  passageId?: string;
  typedText?: string;
  typed: number;
  correct: number;
  errors: number;
  accuracy: number;
  grossWpm: number;
  netWpm: number;
  elapsedMs: number;
  durationSec: number;
  wordsTotal?: number;
  wordsDone?: number;
  wordsCorrect?: number;
  wordAccuracy?: number;
  progress?: number;
  firstKeyMs?: number;
  avgGapMs?: number;
  pauses?: number;
  longestPauseMs?: number;
  peakWpm?: number;
  timelineWpm: number[];
  timelineErr: number[];
  topMistakes: Mistake[];
  strikes: number;
  submittedAtMs: number;
  startedAtMs: number;
}
interface Passage {
  id: string;
  text: string;
}

const card = "rounded-xl border border-slate-200 bg-white p-5";
const btn =
  "rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50";
const btnGhost =
  "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50";
const field = "mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm";
const th = "py-1 pr-3 font-medium";
const td = "py-1 pr-3";

const num = (x: number | undefined, d = 0) =>
  x === undefined ? "-" : String(Math.round(x * 10 ** d) / 10 ** d);
const secs = (ms: number | undefined) =>
  ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : "-");
const vis = (c: string) => (c === " " ? "space" : c);
const wordCount = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);
const cleanText = (t: string) => t.replace(/\s+/g, " ").trim();
const validText = (t: string) => t.length >= 300 && /^[\x20-\x7E]+$/.test(t);

function toRow(id: string, x: DocumentData): Row {
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    id,
    roundId: x.roundId,
    uid: x.uid,
    username: x.username ?? "",
    name: x.name ?? "",
    status: x.status,
    review: x.review,
    flags: x.flags ?? [],
    passageId: x.passageId,
    typedText: x.typedText,
    typed: x.typed ?? 0,
    correct: x.correct ?? 0,
    errors: x.errors ?? 0,
    accuracy: x.accuracy ?? 0,
    grossWpm: x.grossWpm ?? 0,
    netWpm: x.netWpm ?? 0,
    elapsedMs: x.elapsedMs ?? 0,
    durationSec: x.durationSec ?? 0,
    wordsTotal: n(x.wordsTotal),
    wordsDone: n(x.wordsDone),
    wordsCorrect: n(x.wordsCorrect),
    wordAccuracy: n(x.wordAccuracy),
    progress: n(x.progress),
    firstKeyMs: n(x.firstKeyMs),
    avgGapMs: n(x.avgGapMs),
    pauses: n(x.pauses),
    longestPauseMs: n(x.longestPauseMs),
    peakWpm: n(x.peakWpm),
    timelineWpm: x.timelineWpm ?? [],
    timelineErr: x.timelineErr ?? [],
    topMistakes: x.topMistakes ?? [],
    strikes: x.strikes ?? 0,
    submittedAtMs: x.submittedAt?.toMillis?.() ?? 0,
    startedAtMs: x.startedAt?.toMillis?.() ?? 0,
  };
}

const counted = (r: Row) =>
  r.status === "submitted" && (r.review === "valid" || r.review === "cleared");
const byScore = (a: Row, b: Row) =>
  b.netWpm - a.netWpm ||
  b.accuracy - a.accuracy ||
  b.grossWpm - a.grossWpm ||
  a.submittedAtMs - b.submittedAtMs;

/* ---------- small display pieces ---------- */

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200/70">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-bold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function Timeline({ wpm, err }: { wpm: number[]; err: number[] }) {
  const max = Math.max(1, ...wpm);
  return (
    <div className="flex flex-wrap items-end gap-2">
      {wpm.map((w, i) => (
        <div key={i} className="flex w-12 flex-col items-center text-xs text-slate-600">
          <span className="font-medium">{w}</span>
          <div className="mt-1 flex h-20 w-full items-end rounded bg-slate-100">
            <div className="w-full rounded bg-teal-600" style={{ height: `${(w / max) * 100}%` }} />
          </div>
          <span className="mt-1">{i * 10}s</span>
          <span className="text-red-600">{err[i] ?? 0} err</span>
        </div>
      ))}
    </div>
  );
}

function Diff({ passage, typed }: { passage: string; typed: string }) {
  return (
    <p className="max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono text-xs leading-5">
      {passage.split("").map((ch, i) => (
        <span
          key={i}
          className={
            i >= typed.length
              ? "text-slate-400"
              : typed[i] === ch
              ? "text-slate-900"
              : "bg-red-100 text-red-700"
          }
        >
          {ch}
        </span>
      ))}
    </p>
  );
}

/* ---------- page ---------- */

export default function AdminTypingPage() {
  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [pool, setPool] = useState<Passage[] | null>(null);

  const [name, setName] = useState("Round 1");
  const nameTouched = useRef(false);
  const [seconds, setSeconds] = useState(120);

  const [scope, setScope] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadedScope, setLoadedScope] = useState("");
  const [rankBy, setRankBy] = useState<"best" | "avg">("best");
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSec, setEditSec] = useState(120);

  const [newText, setNewText] = useState("");
  const [pEditId, setPEditId] = useState<string | null>(null);
  const [pEditText, setPEditText] = useState("");
  const [msg, setMsg] = useState("");

  const cfgRef = doc(db, "config", "typing");
  const poolRef = doc(db, "config", "typingPool");
  const roundRef = (id: string) => doc(db, "typingRounds", id);

  // Runs an action and shows any error on screen instead of failing silently
  const act = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.error(label, e);
      setMsg(`${label} failed: ${(e as Error).message}`);
    }
  };

  useEffect(
    () =>
      onSnapshot(
        cfgRef,
        (s) => setCfg(s.exists() ? (s.data() as Cfg) : null),
        (e) => setMsg(`Could not read the current round: ${e.message}`)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const loadRounds = useCallback(async () => {
    const snap = await getDocs(collection(db, "typingRounds"));
    const list = snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        name: x.name ?? d.id,
        durationSec: x.durationSec ?? 0,
        status: (x.status ?? "closed") as RoundStatus,
        createdMs: x.createdAt?.toMillis?.() ?? 0,
        startedMs: x.startedAt?.toMillis?.() ?? 0,
        closedMs: x.closedAt?.toMillis?.() ?? 0,
        leaderboard: x.leaderboard ?? null,
      } as Round;
    });
    list.sort((a, b) => b.createdMs - a.createdMs);
    setRounds(list);
  }, []);

  useEffect(() => {
    loadRounds().catch((e) => setMsg(`Could not load rounds: ${e.message}`));
    getDoc(poolRef)
      .then((s) => setPool((s.data()?.passages ?? []) as Passage[]))
      .catch(() => setPool([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRounds]);

  // the current round may not be in the rounds list yet (made before history existed)
  const allRounds = useMemo(() => {
    if (cfg?.roundId && !rounds.some((r) => r.id === cfg.roundId)) {
      return [
        {
          id: cfg.roundId,
          name: cfg.name || cfg.roundId,
          durationSec: cfg.durationSec,
          status: cfg.status,
          createdMs: 0,
          startedMs: cfg.startedAt?.toMillis() ?? 0,
          closedMs: 0,
          leaderboard: cfg.leaderboard,
        } as Round,
        ...rounds,
      ];
    }
    return rounds;
  }, [rounds, cfg]);
  const roundName = (id: string) => allRounds.find((r) => r.id === id)?.name ?? id;

  // suggest the next round name until the admin types their own
  useEffect(() => {
    if (!nameTouched.current) setName(`Round ${allRounds.length + 1}`);
  }, [allRounds.length]);

  useEffect(() => {
    if (cfg !== undefined && scope === "") setScope(cfg?.roundId ?? "all");
  }, [cfg, scope]);

  const status = cfg?.status;
  const running = status === "running";
  const isCurrentLoaded = !!cfg?.roundId && loadedScope === cfg.roundId;

  /* ---------- round control ---------- */

  // Makes sure the current round stays in the history, and closes it if it was running
  function archiveCurrent(batch: WriteBatch) {
    if (!cfg?.roundId) return;
    batch.set(
      roundRef(cfg.roundId),
      {
        name: cfg.name,
        durationSec: cfg.durationSec,
        status: running ? "closed" : cfg.status,
        ...(running ? { closedAt: serverTimestamp() } : {}),
        leaderboard: cfg.leaderboard ?? null,
      },
      { merge: true }
    );
  }

  async function createRound() {
    if (
      running &&
      !window.confirm(
        `"${cfg?.name}" is still running. Close it and create a new round? Students in the middle of a test keep what they have already typed, but can no longer submit to the old round.`
      )
    ) {
      return;
    }
    const id = `r${Date.now()}`;
    const sec = Math.max(10, seconds);
    const n = name.trim() || "Round";
    const batch = writeBatch(db);
    archiveCurrent(batch);
    batch.set(roundRef(id), {
      name: n,
      durationSec: sec,
      status: "lobby",
      createdAt: serverTimestamp(),
      startedAt: null,
      closedAt: null,
      leaderboard: null,
    });
    batch.set(cfgRef, {
      roundId: id,
      name: n,
      durationSec: sec,
      status: "lobby",
      startedAt: null,
      leaderboard: null,
    });
    await batch.commit();
    nameTouched.current = false;
    setScope(id);
    setRows(null);
    await loadRounds();
    setMsg(`Created "${n}". It is now the current round. Press Start round when students are ready.`);
  }

  async function startRound() {
    if (!cfg?.roundId) return;
    const batch = writeBatch(db);
    batch.update(cfgRef, { status: "running", startedAt: serverTimestamp() });
    batch.set(
      roundRef(cfg.roundId),
      { name: cfg.name, durationSec: cfg.durationSec, status: "running", startedAt: serverTimestamp() },
      { merge: true }
    );
    await batch.commit();
    await loadRounds();
    setMsg(`"${cfg.name}" started.`);
  }

  async function closeRound() {
    if (!cfg?.roundId) return;
    const batch = writeBatch(db);
    batch.update(cfgRef, { status: "closed" });
    batch.set(
      roundRef(cfg.roundId),
      { name: cfg.name, durationSec: cfg.durationSec, status: "closed", closedAt: serverTimestamp() },
      { merge: true }
    );
    await batch.commit();
    await loadRounds();
    setMsg(`"${cfg.name}" closed.`);
  }

  async function reopenLobby() {
    if (!cfg?.roundId) return;
    const batch = writeBatch(db);
    batch.update(cfgRef, { status: "lobby", startedAt: null });
    batch.set(
      roundRef(cfg.roundId),
      { name: cfg.name, durationSec: cfg.durationSec, status: "lobby", startedAt: null, closedAt: null },
      { merge: true }
    );
    await batch.commit();
    await loadRounds();
    setMsg("Back in the lobby. Reset the scores if students should be able to take it again.");
  }

  async function makeCurrent(r: Round) {
    if (
      running &&
      !window.confirm(`"${cfg?.name}" is still running. Close it and switch to "${r.name}"?`)
    ) {
      return;
    }
    const batch = writeBatch(db);
    archiveCurrent(batch);
    batch.set(cfgRef, {
      roundId: r.id,
      name: r.name,
      durationSec: r.durationSec,
      status: r.status === "lobby" ? "lobby" : "closed",
      startedAt: null,
      leaderboard: r.leaderboard ?? null,
    });
    await batch.commit();
    setScope(r.id);
    setRows(null);
    await loadRounds();
    setMsg(`"${r.name}" is now the current round.`);
  }

  async function saveEdit(r: Round) {
    const n = editName.trim() || r.name;
    const sec = r.status === "lobby" ? Math.max(10, editSec) : r.durationSec;
    const batch = writeBatch(db);
    batch.set(roundRef(r.id), { name: n, durationSec: sec, status: r.status }, { merge: true });
    if (cfg?.roundId === r.id) batch.update(cfgRef, { name: n, durationSec: sec });
    await batch.commit();
    setEditId(null);
    await loadRounds();
    setMsg(`Renamed to "${n}".`);
  }

  async function deleteAttempts(roundId: string) {
    const snap = await getDocs(
      query(collection(db, "typingAttempts"), where("roundId", "==", roundId))
    );
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return snap.size;
  }

  async function resetRound(r: Round) {
    const live = running && cfg?.roundId === r.id;
    if (
      !window.confirm(
        live
          ? `"${r.name}" is running right now. Delete every score in it? Students who already finished will be able to take it again.`
          : `Delete every score in "${r.name}"? Students will be able to take it again.`
      )
    ) {
      return;
    }
    const n = await deleteAttempts(r.id);
    const batch = writeBatch(db);
    batch.set(roundRef(r.id), { name: r.name, durationSec: r.durationSec, leaderboard: null }, { merge: true });
    if (cfg?.roundId === r.id) batch.update(cfgRef, { leaderboard: null });
    await batch.commit();
    if (loadedScope === r.id || loadedScope === "all") setRows(null);
    await loadRounds();
    setMsg(`Reset "${r.name}": removed ${n} attempts.`);
  }

  async function deleteRound(r: Round) {
    const live = running && cfg?.roundId === r.id;
    if (
      !window.confirm(
        live
          ? `"${r.name}" is running right now. Delete it and all its scores? Students will see that no round is open. This cannot be undone.`
          : `Delete "${r.name}" and all its scores? This cannot be undone.`
      )
    ) {
      return;
    }
    const n = await deleteAttempts(r.id);
    const batch = writeBatch(db);
    batch.delete(roundRef(r.id));
    if (cfg?.roundId === r.id) {
      batch.set(cfgRef, {
        roundId: null,
        name: "",
        durationSec: 120,
        status: "idle",
        startedAt: null,
        leaderboard: null,
      });
    }
    await batch.commit();
    setRounds((rs) => rs.filter((x) => x.id !== r.id));
    if (scope === r.id) setScope("all");
    setRows(null);
    setMsg(`Deleted "${r.name}" and ${n} attempts.`);
  }

  /* ---------- results ---------- */

  const refresh = useCallback(async () => {
    if (!scope) return;
    setRefreshing(true);
    try {
      const q =
        scope === "all"
          ? collection(db, "typingAttempts")
          : query(collection(db, "typingAttempts"), where("roundId", "==", scope));
      const snap = await getDocs(q);
      setRows(snap.docs.map((d) => toRow(d.id, d.data())));
      setLoadedScope(scope);
      setOpenId(null);
    } catch (e) {
      setMsg(`Could not load results: ${(e as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }, [scope]);

  const viewing = rows !== null && loadedScope === scope;
  const isAll = loadedScope === "all";

  const ranked = useMemo(
    () => (viewing && !isAll ? (rows ?? []).filter(counted).sort(byScore) : []),
    [rows, viewing, isAll]
  );
  const flagged = (viewing ? rows ?? [] : []).filter((r) => r.review === "flagged");
  const disqualified = (viewing ? rows ?? [] : []).filter((r) => r.review === "disqualified");
  const notSubmitted = (viewing ? rows ?? [] : []).filter((r) => r.status === "started");

  const stats = useMemo(() => {
    const list = viewing ? rows ?? [] : [];
    const done = list.filter((r) => r.status === "submitted");
    const ok = done.filter(counted);
    const avg = (f: (r: Row) => number) =>
      ok.length ? ok.reduce((a, r) => a + f(r), 0) / ok.length : 0;
    return {
      total: list.length,
      submitted: done.length,
      notSubmitted: list.length - done.length,
      flagged: list.filter((r) => r.review === "flagged").length,
      avgNet: avg((r) => r.netWpm),
      avgAcc: avg((r) => r.accuracy),
      topNet: ok.length ? Math.max(...ok.map((r) => r.netWpm)) : 0,
      words: done.reduce((a, r) => a + (r.wordsDone ?? 0), 0),
      chars: done.reduce((a, r) => a + r.typed, 0),
    };
  }, [rows, viewing]);

  const combined = useMemo(() => {
    if (!viewing || !isAll) return [];
    const byUid = new Map<string, Row[]>();
    for (const r of rows ?? []) {
      if (!counted(r)) continue;
      const a = byUid.get(r.uid) ?? [];
      a.push(r);
      byUid.set(r.uid, a);
    }
    const out = [...byUid.entries()].map(([uid, list]) => {
      const net = list.map((x) => x.netWpm);
      const avgNet = net.reduce((a, b) => a + b, 0) / net.length;
      return {
        uid,
        username: list[0].username,
        name: list[0].name,
        rounds: list.length,
        best: Math.max(...net),
        avg: avgNet,
        acc: list.reduce((a, x) => a + x.accuracy, 0) / list.length,
        words: list.reduce((a, x) => a + (x.wordsDone ?? 0), 0),
        perRound: [...list]
          .sort((a, b) => a.submittedAtMs - b.submittedAtMs)
          .map((x) => `${roundName(x.roundId)}: ${x.netWpm}`)
          .join(", "),
      };
    });
    out.sort(
      rankBy === "best"
        ? (a, b) => b.best - a.best || b.acc - a.acc
        : (a, b) => b.avg - a.avg || b.acc - a.acc
    );
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewing, isAll, rankBy, allRounds]);

  async function setReview(id: string, review: Review) {
    await updateDoc(doc(db, "typingAttempts", id), { review });
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, review } : r)) ?? null);
  }

  async function resetAttempt(r: Row) {
    if (!window.confirm(`Delete ${r.username}'s attempt in "${roundName(r.roundId)}"? They will be able to take it again.`)) return;
    await deleteDoc(doc(db, "typingAttempts", r.id));
    setRows((rs) => rs?.filter((x) => x.id !== r.id) ?? null);
    if (openId === r.id) setOpenId(null);
    setMsg(
      `${r.username}'s attempt was deleted. Ask them to press Back to events and open Typing again (not refresh).`
    );
  }

  const publish = async () => {
    if (!cfg?.roundId) return;
    const board: LeaderRow[] = ranked.slice(0, 10).map((r, i) => ({
      rank: i + 1,
      name: r.name,
      username: r.username,
      netWpm: r.netWpm,
      accuracy: r.accuracy,
    }));
    const batch = writeBatch(db);
    batch.update(cfgRef, { leaderboard: board });
    batch.set(roundRef(cfg.roundId), { name: cfg.name, durationSec: cfg.durationSec, leaderboard: board }, { merge: true });
    await batch.commit();
    await loadRounds();
    setMsg("Leaderboard published.");
  };

  const unpublish = async () => {
    if (!cfg?.roundId) return;
    const batch = writeBatch(db);
    batch.update(cfgRef, { leaderboard: null });
    batch.set(roundRef(cfg.roundId), { name: cfg.name, durationSec: cfg.durationSec, leaderboard: null }, { merge: true });
    await batch.commit();
    await loadRounds();
    setMsg("Leaderboard hidden.");
  };

  function exportCsv() {
    if (!rows) return;
    const head = [
      "round", "username", "name", "status", "review", "flags", "net_wpm", "gross_wpm", "accuracy_pct",
      "chars_typed", "chars_correct", "errors", "words_done", "words_correct", "words_total",
      "time_used_s", "first_key_s", "avg_gap_ms", "pauses_over_2s", "longest_pause_s", "peak_wpm",
      "violations", "submitted_at",
    ];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [
        roundName(r.roundId), r.username, r.name, r.status, r.review ?? "", r.flags.join(" "),
        r.netWpm, r.grossWpm, r.accuracy, r.typed, r.correct, r.errors,
        r.wordsDone ?? "", r.wordsCorrect ?? "", r.wordsTotal ?? "",
        (r.elapsedMs / 1000).toFixed(1),
        r.firstKeyMs === undefined ? "" : (r.firstKeyMs / 1000).toFixed(2),
        r.avgGapMs ?? "", r.pauses ?? "",
        r.longestPauseMs === undefined ? "" : (r.longestPauseMs / 1000).toFixed(1),
        r.peakWpm ?? "", r.strikes,
        r.submittedAtMs ? new Date(r.submittedAtMs).toISOString() : "",
      ]
        .map(esc)
        .join(",")
    );
    const blob = new Blob([[head.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `typing-${isAll ? "all-rounds" : roundName(loadedScope)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- passage pool ---------- */

  async function savePool(next: Passage[]) {
    await setDoc(poolRef, { passages: next });
    setPool(next);
  }

  async function addPassage() {
    const text = cleanText(newText);
    if (!validText(text)) {
      return setMsg("A passage needs at least 300 characters, using only plain keyboard characters.");
    }
    await savePool([...(pool ?? []), { id: `a${Date.now()}`, text }]);
    setNewText("");
    setMsg("Passage added. Students get new passages within a minute.");
  }

  async function savePassage(id: string) {
    const text = cleanText(pEditText);
    if (!validText(text)) {
      return setMsg("A passage needs at least 300 characters, using only plain keyboard characters.");
    }
    await savePool((pool ?? []).map((p) => (p.id === id ? { ...p, text } : p)));
    setPEditId(null);
  }

  async function deletePassage(id: string) {
    if ((pool ?? []).length <= 1) return setMsg("Keep at least one passage.");
    if (!window.confirm("Delete this passage? Old attempts will no longer show its text.")) return;
    await savePool((pool ?? []).filter((p) => p.id !== id));
  }

  /* ---------- tables ---------- */

  const passageOf = (id?: string) => pool?.find((p) => p.id === id)?.text;

  function attemptTable(list: Row[], showRank: boolean, showRound: boolean) {
    return (
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              {showRank && <th className={th}>#</th>}
              {showRound && <th className={th}>Round</th>}
              <th className={th}>Student</th>
              <th className={th}>Net WPM</th>
              <th className={th}>Gross</th>
              <th className={th}>Accuracy</th>
              <th className={th}>Words</th>
              <th className={th}>Right</th>
              <th className={th}>Chars</th>
              <th className={th}>Errors</th>
              <th className={th}>Time</th>
              <th className={th}>Viol.</th>
              <th className={th}>Review</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="text-slate-700">
            {list.map((r, i) => (
              <tr key={r.id} className="border-t border-slate-100">
                {showRank && <td className={td}>{i + 1}</td>}
                {showRound && <td className={td}>{roundName(r.roundId)}</td>}
                <td className={td}>{r.username}</td>
                <td className={`${td} font-medium`}>{r.status === "submitted" ? r.netWpm : "-"}</td>
                <td className={td}>{r.status === "submitted" ? r.grossWpm : "-"}</td>
                <td className={td}>{r.status === "submitted" ? `${r.accuracy}%` : "-"}</td>
                <td className={td}>{num(r.wordsDone)}</td>
                <td className={td}>{num(r.wordsCorrect)}</td>
                <td className={td}>{r.status === "submitted" ? r.typed : "-"}</td>
                <td className={td}>{r.status === "submitted" ? r.errors : "-"}</td>
                <td className={td}>{r.status === "submitted" ? secs(r.elapsedMs) : "-"}</td>
                <td className={td}>{r.strikes}</td>
                <td className={td}>{r.status === "started" ? "no result" : r.review ?? "-"}</td>
                <td className={`${td} whitespace-nowrap`}>
                  <button className={btnGhost} onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                    Details
                  </button>{" "}
                  <button className={btnGhost} onClick={() => act("Reset attempt", () => resetAttempt(r))}>
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const open = rows?.find((r) => r.id === openId);
  const openPassage = passageOf(open?.passageId);

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin: Typing" />
      <main className="mx-auto max-w-6xl space-y-6 p-6">
        <Link href="/admin" className="text-sm text-teal-800 hover:underline">
          Back to admin
        </Link>
        {msg && (
          <p className="flex items-start justify-between gap-3 rounded-md bg-teal-50 p-2 text-sm text-teal-900">
            <span>{msg}</span>
            <button className="font-semibold underline" onClick={() => setMsg("")}>
              Dismiss
            </button>
          </p>
        )}

        {/* CURRENT ROUND */}
        <section className={card}>
          <h2 className="font-semibold text-[#101828]">Current round</h2>
          <p className="mt-2 text-sm text-slate-700">
            {cfg === undefined
              ? "Loading…"
              : cfg && cfg.roundId
              ? `${cfg.name} (${cfg.durationSec}s): ${status}`
              : "No round yet."}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-700">New round name
              <input
                className={field}
                value={name}
                onChange={(e) => {
                  nameTouched.current = true;
                  setName(e.target.value);
                }}
              />
            </label>
            <label className="text-sm text-slate-700">Duration (seconds)
              <input type="number" min={10} className={`${field} w-28`} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} />
            </label>
            <button className={btn} onClick={() => act("Create round", createRound)}>
              Create new round
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className={btn} disabled={status !== "lobby"} onClick={() => act("Start round", startRound)}>Start round</button>
            <button className={btnGhost} disabled={!running} onClick={() => act("Close round", closeRound)}>Close round</button>
            <button className={btnGhost} disabled={status !== "closed"} onClick={() => act("Reopen round", reopenLobby)}>Reopen as lobby</button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Creating a round keeps all earlier rounds and their scores, and closes the current one if it
            is running. After Start, waiting students get a 10 second countdown, and late students can still
            begin until you close the round.
          </p>
        </section>

        {/* ROUNDS */}
        <section className={card}>
          <h2 className="font-semibold text-[#101828]">All rounds ({allRounds.length})</h2>
          {allRounds.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">No rounds yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-slate-500">
                  <tr>
                    <th className={th}>Name</th>
                    <th className={th}>Duration</th>
                    <th className={th}>Status</th>
                    <th className={th}>Created</th>
                    <th className={th}>Published</th>
                    <th className={th} />
                  </tr>
                </thead>
                <tbody className="text-slate-700">
                  {allRounds.map((r) => {
                    const isCur = cfg?.roundId === r.id;
                    return (
                      <tr key={r.id} className="border-t border-slate-100 align-top">
                        <td className={td}>
                          {editId === r.id ? (
                            <input
                              className={field}
                              value={editName}
                              autoFocus
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") act("Rename", () => saveEdit(r));
                                if (e.key === "Escape") setEditId(null);
                              }}
                            />
                          ) : (
                            <>
                              <b>{r.name}</b>
                              {isCur && (
                                <span className="ml-2 rounded-full bg-teal-100 px-2 py-0.5 text-xs text-teal-800">
                                  current
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className={td}>
                          {editId === r.id && r.status === "lobby" ? (
                            <input type="number" min={10} className={`${field} w-24`} value={editSec} onChange={(e) => setEditSec(Number(e.target.value))} />
                          ) : (
                            `${r.durationSec}s`
                          )}
                        </td>
                        <td className={td}>{isCur ? status : r.status}</td>
                        <td className={td}>{when(r.createdMs)}</td>
                        <td className={td}>{r.leaderboard ? "yes" : "no"}</td>
                        <td className={`${td} space-x-1 whitespace-nowrap`}>
                          {editId === r.id ? (
                            <>
                              <button className={btn} onClick={() => act("Rename", () => saveEdit(r))}>Save</button>
                              <button className={btnGhost} onClick={() => setEditId(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className={btnGhost} onClick={() => { setScope(r.id); setRows(null); }}>View results</button>
                              <button className={btnGhost} disabled={isCur} onClick={() => act("Make current", () => makeCurrent(r))}>Make current</button>
                              <button className={btnGhost} onClick={() => { setEditId(r.id); setEditName(r.name); setEditSec(r.durationSec); }}>Rename</button>
                              <button className={btnGhost} onClick={() => act("Reset scores", () => resetRound(r))}>Reset scores</button>
                              <button className={btnGhost} onClick={() => act("Delete round", () => deleteRound(r))}>Delete</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* RESULTS */}
        <section className={card}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold text-[#101828]">Results</h2>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sm text-slate-700">View
                <select className={field} value={scope} onChange={(e) => setScope(e.target.value)}>
                  {allRounds.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                  <option value="all">All rounds together</option>
                </select>
              </label>
              <button className={btnGhost} onClick={refresh} disabled={!scope || refreshing}>
                {refreshing ? "Loading…" : viewing ? "Refresh" : "Load"}
              </button>
              <button className={btnGhost} onClick={exportCsv} disabled={!viewing || !rows?.length}>Export CSV</button>
              <button className={btn} onClick={() => act("Publish", publish)} disabled={!isCurrentLoaded || ranked.length === 0}>Publish top 10</button>
              <button className={btnGhost} onClick={() => act("Unpublish", unpublish)} disabled={!cfg?.leaderboard}>Unpublish</button>
            </div>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Not live, to keep Firebase usage low. Press Load or Refresh. Ranking: net WPM, then
            accuracy, then gross WPM, then who finished first. Only valid and cleared results are
            ranked. Publish works on the current round after you load it.
          </p>

          {!viewing ? (
            <p className="mt-3 text-sm text-slate-600">Pick a view and press Load.</p>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                <Tile label="Attempts" value={stats.total} />
                <Tile label="Submitted" value={stats.submitted} />
                <Tile label="No result" value={stats.notSubmitted} />
                <Tile label="Flagged" value={stats.flagged} />
                <Tile label="Top net WPM" value={num(stats.topNet, 1)} />
                <Tile label="Avg net WPM" value={num(stats.avgNet, 1)} />
                <Tile label="Avg accuracy" value={`${num(stats.avgAcc, 1)}%`} />
                <Tile label="Words typed" value={stats.words} />
              </div>

              {isAll ? (
                <>
                  <div className="mt-5 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-800">Students across all rounds</h3>
                    <label className="text-sm text-slate-700">Rank by
                      <select className={`${field} inline-block`} value={rankBy} onChange={(e) => setRankBy(e.target.value as "best" | "avg")}>
                        <option value="best">Best net WPM</option>
                        <option value="avg">Average net WPM</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="text-slate-500">
                        <tr>
                          <th className={th}>#</th>
                          <th className={th}>Student</th>
                          <th className={th}>Rounds</th>
                          <th className={th}>Best net</th>
                          <th className={th}>Avg net</th>
                          <th className={th}>Avg accuracy</th>
                          <th className={th}>Words</th>
                          <th className={th}>Per round (net WPM)</th>
                        </tr>
                      </thead>
                      <tbody className="text-slate-700">
                        {combined.map((c, i) => (
                          <tr key={c.uid} className="border-t border-slate-100">
                            <td className={td}>{i + 1}</td>
                            <td className={td}>{c.username}</td>
                            <td className={td}>{c.rounds}</td>
                            <td className={`${td} font-medium`}>{num(c.best, 1)}</td>
                            <td className={td}>{num(c.avg, 1)}</td>
                            <td className={td}>{num(c.acc, 1)}%</td>
                            <td className={td}>{c.words}</td>
                            <td className={td}>{c.perRound}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <h3 className="mt-6 text-sm font-semibold text-slate-800">Every attempt</h3>
                  {attemptTable(
                    [...(rows ?? [])].sort(
                      (a, b) => roundName(a.roundId).localeCompare(roundName(b.roundId)) || byScore(a, b)
                    ),
                    false,
                    true
                  )}
                </>
              ) : (
                <>
                  <h3 className="mt-5 text-sm font-semibold text-slate-800">Ranking ({ranked.length})</h3>
                  {attemptTable(ranked, true, false)}

                  {flagged.length > 0 && (
                    <div className="mt-5">
                      <h3 className="font-medium text-amber-800">Flagged for review ({flagged.length})</h3>
                      <ul className="mt-2 space-y-2 text-sm">
                        {flagged.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-2">
                            <span>{r.username}: {r.netWpm} net WPM, {r.accuracy}% ({r.flags.join(", ")})</span>
                            <span className="flex gap-2">
                              <button className={btnGhost} onClick={() => setOpenId(r.id)}>Details</button>
                              <button className={btnGhost} onClick={() => act("Clear", () => setReview(r.id, "cleared"))}>Clear</button>
                              <button className={btnGhost} onClick={() => act("Disqualify", () => setReview(r.id, "disqualified"))}>Disqualify</button>
                              <button className={btnGhost} onClick={() => act("Reset attempt", () => resetAttempt(r))}>Reset</button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {disqualified.length > 0 && (
                    <div className="mt-5">
                      <h3 className="font-medium text-red-800">Disqualified ({disqualified.length})</h3>
                      <ul className="mt-2 space-y-2 text-sm">
                        {disqualified.map((r) => (
                          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-red-50 p-2">
                            <span>{r.username}: {r.netWpm} net WPM, {r.accuracy}%</span>
                            <span className="flex gap-2">
                              <button className={btnGhost} onClick={() => setOpenId(r.id)}>Details</button>
                              <button className={btnGhost} onClick={() => act("Reinstate", () => setReview(r.id, "cleared"))}>Reinstate</button>
                              <button className={btnGhost} onClick={() => act("Reset attempt", () => resetAttempt(r))}>Reset</button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {notSubmitted.length > 0 && (
                    <div className="mt-5">
                      <h3 className="font-medium text-slate-800">Started but no result ({notSubmitted.length})</h3>
                      <p className="text-xs text-slate-500">
                        Still typing, or refreshed, or lost connection. Reset lets them take it again.
                      </p>
                      <ul className="mt-2 space-y-2 text-sm">
                        {notSubmitted.map((r) => (
                          <li key={r.id} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 p-2">
                            <span>{r.username}: started {when(r.startedAtMs)}</span>
                            <button className={btnGhost} onClick={() => act("Reset attempt", () => resetAttempt(r))}>Reset</button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}

              {/* DETAILS */}
              {open && (
                <div className="mt-6 rounded-lg border border-slate-200 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-semibold text-slate-900">
                      {open.username} ({open.name}) in {roundName(open.roundId)}
                    </p>
                    <button className={btnGhost} onClick={() => setOpenId(null)}>Close</button>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Passage {open.passageId ?? "-"}. Started {when(open.startedAtMs)}, submitted {when(open.submittedAtMs)}.
                    Review: {open.review ?? "-"}
                    {open.flags.length ? ` (flags: ${open.flags.join(", ")})` : ""}.
                  </p>

                  {open.status !== "submitted" ? (
                    <p className="mt-3 text-sm text-slate-600">No result was submitted for this attempt.</p>
                  ) : (
                    <>
                      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                        <Tile label="Net WPM" value={open.netWpm} />
                        <Tile label="Gross WPM" value={open.grossWpm} />
                        <Tile label="Accuracy" value={`${open.accuracy}%`} />
                        <Tile label="Peak WPM (10s)" value={num(open.peakWpm, 1)} />
                        <Tile label="Words done" value={`${num(open.wordsDone)} of ${num(open.wordsTotal)}`} />
                        <Tile label="Words right" value={`${num(open.wordsCorrect)} (${num(open.wordAccuracy, 1)}%)`} />
                        <Tile label="Chars typed" value={open.typed} />
                        <Tile label="Chars right" value={open.correct} />
                        <Tile label="Errors" value={open.errors} />
                        <Tile label="Time used" value={secs(open.elapsedMs)} />
                        <Tile label="Of passage" value={`${num(open.progress, 1)}%`} />
                        <Tile label="Violations" value={open.strikes} />
                        <Tile label="First key at" value={secs(open.firstKeyMs)} />
                        <Tile label="Avg gap" value={open.avgGapMs === undefined ? "-" : `${open.avgGapMs} ms`} />
                        <Tile label="Pauses over 2s" value={num(open.pauses)} />
                        <Tile label="Longest pause" value={secs(open.longestPauseMs)} />
                      </div>

                      {open.timelineWpm.length > 0 && (
                        <div className="mt-4">
                          <p className="text-sm font-medium text-slate-800">Speed over time (WPM per 10 seconds)</p>
                          <div className="mt-2">
                            <Timeline wpm={open.timelineWpm} err={open.timelineErr} />
                          </div>
                        </div>
                      )}

                      {open.topMistakes.length > 0 && (
                        <div className="mt-4">
                          <p className="text-sm font-medium text-slate-800">Most common mistakes</p>
                          <ul className="mt-1 text-sm text-slate-700">
                            {open.topMistakes.map((m, i) => (
                              <li key={i}>
                                should be <code>{vis(m.expected)}</code>, typed <code>{vis(m.typed)}</code>: {m.count} time{m.count > 1 ? "s" : ""}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="mt-4">
                        <p className="text-sm font-medium text-slate-800">
                          Passage compared with what was typed (red = wrong, grey = not reached)
                        </p>
                        <div className="mt-1">
                          {openPassage && open.typedText !== undefined ? (
                            <Diff passage={openPassage} typed={open.typedText} />
                          ) : (
                            <p className="text-sm text-slate-500">
                              {open.typedText === undefined
                                ? "This attempt was made before detailed results were saved."
                                : "The passage was deleted, so it can't be shown."}
                            </p>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* PASSAGES */}
        <section className={card}>
          <h2 className="font-semibold text-[#101828]">Passage pool {pool && `(${pool.length})`}</h2>
          <p className="mt-1 text-xs text-slate-500">
            Each student gets a random passage. You can edit the pool only when no round is running.
            Use plain keyboard characters only, at least 300 characters.
          </p>
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {(pool ?? []).map((p) => (
              <li key={p.id} className="rounded-md border border-slate-100 p-2">
                {pEditId === p.id ? (
                  <>
                    <textarea rows={5} className={`${field} w-full`} value={pEditText} onChange={(e) => setPEditText(e.target.value)} />
                    <div className="mt-2 flex gap-2">
                      <button className={btn} onClick={() => act("Save passage", () => savePassage(p.id))}>Save</button>
                      <button className={btnGhost} onClick={() => setPEditId(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <span>
                      <b>{p.id}</b> ({wordCount(p.text)} words): {p.text.slice(0, 110)}…
                    </span>
                    <span className="flex gap-2">
                      <button className={btnGhost} disabled={running} onClick={() => { setPEditId(p.id); setPEditText(p.text); }}>Edit</button>
                      <button className={btnGhost} disabled={running} onClick={() => act("Delete passage", () => deletePassage(p.id))}>Delete</button>
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={4}
            placeholder="Paste a new passage (about 300 words)."
            className={`${field} mt-3 w-full`}
          />
          <button className={`${btn} mt-2`} disabled={running} onClick={() => act("Add passage", addPassage)}>Add passage</button>
        </section>
      </main>
    </div>
  );
}