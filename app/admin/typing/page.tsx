"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  arrayUnion,
  collection,
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
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import AppHeader from "@/components/app-header";
import { LeaderRow, RoundStatus } from "@/lib/typing";

interface Cfg {
  roundId: string | null;
  name: string;
  durationSec: number;
  status: RoundStatus;
  startedAt: Timestamp | null;
  leaderboard: LeaderRow[] | null;
}

type Review = "valid" | "flagged" | "cleared" | "disqualified";

interface Row {
  id: string;
  username: string;
  name: string;
  status: "started" | "submitted";
  review?: Review;
  flags?: string[];
  typed: number;
  errors: number;
  accuracy: number;
  grossWpm: number;
  netWpm: number;
  strikes: number;
  submittedAtMs: number;
}

const card = "rounded-xl border border-slate-200 bg-white p-5";
const btn =
  "rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50";
const btnGhost =
  "rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50";

export default function AdminTypingPage() {
  const [cfg, setCfg] = useState<Cfg | null | undefined>(undefined);
  const [name, setName] = useState("Round 1");
  const [seconds, setSeconds] = useState(120);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [poolCount, setPoolCount] = useState<number | null>(null);
  const [newText, setNewText] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(
    () =>
      onSnapshot(doc(db, "config", "typing"), (s) =>
        setCfg(s.exists() ? (s.data() as Cfg) : null)
      ),
    []
  );

  useEffect(() => {
    getDoc(doc(db, "config", "typingPool"))
      .then((s) => setPoolCount((s.data()?.passages ?? []).length))
      .catch(() => setPoolCount(0));
  }, []);

  const cfgRef = doc(db, "config", "typing");

  const createRound = () =>
    setDoc(cfgRef, {
      roundId: `r${Date.now()}`,
      name: name.trim() || "Round",
      durationSec: Math.max(10, seconds),
      status: "lobby",
      startedAt: null,
      leaderboard: null,
    }).then(() => setRows(null));

  const startRound = () =>
    updateDoc(cfgRef, { status: "running", startedAt: serverTimestamp() });

  const closeRound = () => updateDoc(cfgRef, { status: "closed" });

  const refresh = useCallback(async () => {
    if (!cfg?.roundId) return;
    setRefreshing(true);
    try {
      const snap = await getDocs(
        query(collection(db, "typingAttempts"), where("roundId", "==", cfg.roundId))
      );
      setRows(
        snap.docs.map((d) => {
          const x = d.data();
          return {
            id: d.id,
            username: x.username,
            name: x.name,
            status: x.status,
            review: x.review,
            flags: x.flags,
            typed: x.typed ?? 0,
            errors: x.errors ?? 0,
            accuracy: x.accuracy ?? 0,
            grossWpm: x.grossWpm ?? 0,
            netWpm: x.netWpm ?? 0,
            strikes: x.strikes ?? 0,
            submittedAtMs: x.submittedAt?.toMillis?.() ?? 0,
          } as Row;
        })
      );
    } finally {
      setRefreshing(false);
    }
  }, [cfg?.roundId]);

  const ranked = useMemo(
    () =>
      (rows ?? [])
        .filter(
          (r) =>
            r.status === "submitted" &&
            (r.review === "valid" || r.review === "cleared")
        )
        .sort(
          (a, b) =>
            b.netWpm - a.netWpm ||
            b.accuracy - a.accuracy ||
            b.grossWpm - a.grossWpm ||
            a.submittedAtMs - b.submittedAtMs
        ),
    [rows]
  );
  const flagged = (rows ?? []).filter((r) => r.review === "flagged");
  const inProgress = (rows ?? []).filter((r) => r.status === "started").length;

  async function setReview(id: string, review: "cleared" | "disqualified") {
    await updateDoc(doc(db, "typingAttempts", id), { review });
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, review } : r)) ?? null);
  }

  const publish = () =>
    updateDoc(cfgRef, {
      leaderboard: ranked.slice(0, 10).map((r, i) => ({
        rank: i + 1,
        name: r.name,
        username: r.username,
        netWpm: r.netWpm,
        accuracy: r.accuracy,
      })),
    });

  const unpublish = () => updateDoc(cfgRef, { leaderboard: null });

  async function addPassage() {
    const text = newText.replace(/\s+/g, " ").trim();
    if (text.length < 300) {
      setMsg("Too short. Use at least 300 characters so nobody finishes early.");
      return;
    }
    await setDoc(
      doc(db, "config", "typingPool"),
      { passages: arrayUnion({ id: `a${Date.now()}`, text }) },
      { merge: true }
    );
    setPoolCount((c) => (c ?? 0) + 1);
    setNewText("");
    setMsg("Passage added.");
  }

  const status = cfg?.status;

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin: Typing" />
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <Link href="/admin" className="text-sm text-teal-800 hover:underline">
          Back to admin
        </Link>

        <section className={card}>
          <h2 className="font-semibold text-[#101828]">Round</h2>
          {cfg === undefined ? (
            <p className="mt-2 text-sm text-slate-600">Loading…</p>
          ) : (
            <p className="mt-2 text-sm text-slate-700">
              {cfg && cfg.roundId
                ? `${cfg.name} (${cfg.durationSec}s): ${status}`
                : "No round yet."}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-sm text-slate-700">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 block rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <label className="text-sm text-slate-700">
              Duration (seconds)
              <input
                type="number"
                min={10}
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
                className="mt-1 block w-28 rounded-md border border-slate-300 px-2 py-1"
              />
            </label>
            <button className={btn} onClick={createRound}>
              Create new round
            </button>
          </div>
          <div className="mt-4 flex gap-3">
            <button className={btn} disabled={status !== "lobby"} onClick={startRound}>
              Start round
            </button>
            <button className={btnGhost} disabled={status !== "running"} onClick={closeRound}>
              Close round
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Creating a round replaces the current one. Students already waiting get a
            10 second countdown after Start. Late students can still begin until you
            press Close.
          </p>
        </section>

        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[#101828]">Results</h2>
            <div className="flex gap-2">
              <button className={btnGhost} onClick={refresh} disabled={!cfg?.roundId || refreshing}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              <button className={btn} onClick={publish} disabled={ranked.length === 0}>
                Publish top 10
              </button>
              <button className={btnGhost} onClick={unpublish} disabled={!cfg?.leaderboard}>
                Unpublish
              </button>
            </div>
          </div>
          {rows === null ? (
            <p className="mt-2 text-sm text-slate-600">
              Press Refresh to load results. This is deliberately not live, to keep
              Firebase usage low.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">
                {ranked.length} ranked, {flagged.length} flagged, {inProgress} still typing
                or never submitted.
                {cfg?.leaderboard ? " Leaderboard is published." : ""}
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-slate-500">
                    <tr>
                      <th className="py-1 pr-3 font-medium">#</th>
                      <th className="py-1 pr-3 font-medium">Student</th>
                      <th className="py-1 pr-3 font-medium">Net WPM</th>
                      <th className="py-1 pr-3 font-medium">Accuracy</th>
                      <th className="py-1 pr-3 font-medium">Gross WPM</th>
                      <th className="py-1 pr-3 font-medium">Errors</th>
                      <th className="py-1 font-medium">Violations</th>
                    </tr>
                  </thead>
                  <tbody className="text-slate-700">
                    {ranked.map((r, i) => (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="py-1 pr-3">{i + 1}</td>
                        <td className="py-1 pr-3">{r.username}</td>
                        <td className="py-1 pr-3">{r.netWpm}</td>
                        <td className="py-1 pr-3">{r.accuracy}%</td>
                        <td className="py-1 pr-3">{r.grossWpm}</td>
                        <td className="py-1 pr-3">{r.errors}</td>
                        <td className="py-1">{r.strikes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {flagged.length > 0 && (
                <div className="mt-5">
                  <h3 className="font-medium text-amber-800">Flagged for review</h3>
                  <ul className="mt-2 space-y-2 text-sm">
                    {flagged.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-2"
                      >
                        <span>
                          {r.username}: {r.netWpm} net WPM, {r.accuracy}% ({r.flags?.join(", ")})
                        </span>
                        <span className="flex gap-2">
                          <button className={btnGhost} onClick={() => setReview(r.id, "cleared")}>
                            Clear
                          </button>
                          <button className={btnGhost} onClick={() => setReview(r.id, "disqualified")}>
                            Disqualify
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>

        <section className={card}>
          <h2 className="font-semibold text-[#101828]">
            Passage pool {poolCount !== null && `(${poolCount})`}
          </h2>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={4}
            placeholder="Paste a new passage. Use plain keyboard characters only, about 300 words."
            className="mt-3 w-full rounded-md border border-slate-300 p-2 text-sm"
          />
          <div className="mt-2 flex items-center gap-3">
            <button className={btn} onClick={addPassage}>
              Add passage
            </button>
            {msg && <span className="text-sm text-slate-600">{msg}</span>}
          </div>
        </section>
      </main>
    </div>
  );
}