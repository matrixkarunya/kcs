"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import AppHeader from "@/components/app-header";
import Link from "next/link";

interface Student {
  id: string;
  username: string;
  name: string;
}

interface Session {
  id: string;
  username: string;
  name: string;
  strikes: number;
  locked: boolean;
  lastReason?: string;
}

type Tab = "sessions" | "students";
type SessionFilter = "all" | "locked" | "flagged" | "clean";
type StudentFilter = "all" | "joined" | "waiting";
type SortKey = "username" | "strikes";

const byUsername = (a: { username: string }, b: { username: string }) =>
  a.username.localeCompare(b.username, undefined, { numeric: true });

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-1";

export default function AdminPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [studentsLoaded, setStudentsLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);

  const [tab, setTab] = useState<Tab>("sessions");
  const [search, setSearch] = useState("");
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>("all");
  const [studentFilter, setStudentFilter] = useState<StudentFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("username");
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(
    null
  );

  // Live students
  useEffect(() => {
    return onSnapshot(
      query(collection(db, "users"), where("role", "==", "student")),
      (snap) => {
        const rows = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Student, "id">),
        }));
        rows.sort(byUsername);
        setStudents(rows);
        setStudentsLoaded(true);
      },
      () => setStudentsLoaded(true)
    );
  }, []);

  // Live sessions
  useEffect(() => {
    return onSnapshot(
      collection(db, "sessions"),
      (snap) => {
        const rows = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Session, "id">),
        }));
        setSessions(rows);
        setSessionsLoaded(true);
      },
      () => setSessionsLoaded(true)
    );
  }, []);

  // Auto-dismiss notices
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  // Keep selection in sync with what still needs a reset
  useEffect(() => {
    setSelected((prev) => {
      const valid = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => valid.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const stats = useMemo(() => {
    const locked = sessions.filter((s) => s.locked).length;
    const flagged = sessions.filter((s) => !s.locked && s.strikes > 0).length;
    return {
      total: students.length,
      joined: sessions.length,
      locked,
      flagged,
    };
  }, [students, sessions]);

  const joinedUsernames = useMemo(
    () => new Set(sessions.map((s) => s.username)),
    [sessions]
  );

  const q = search.trim().toLowerCase();

  const visibleSessions = useMemo(() => {
    const rows = sessions.filter((s) => {
      if (q && !`${s.username} ${s.name ?? ""}`.toLowerCase().includes(q))
        return false;
      if (sessionFilter === "locked") return s.locked;
      if (sessionFilter === "flagged") return !s.locked && s.strikes > 0;
      if (sessionFilter === "clean") return !s.locked && s.strikes === 0;
      return true;
    });
    rows.sort((a, b) => {
      const cmp =
        sortKey === "strikes"
          ? a.strikes - b.strikes || byUsername(a, b)
          : byUsername(a, b);
      return sortAsc ? cmp : -cmp;
    });
    return rows;
  }, [sessions, q, sessionFilter, sortKey, sortAsc]);

  const visibleStudents = useMemo(
    () =>
      students.filter((s) => {
        if (q && !`${s.username} ${s.name ?? ""}`.toLowerCase().includes(q))
          return false;
        if (studentFilter === "joined") return joinedUsernames.has(s.username);
        if (studentFilter === "waiting") return !joinedUsernames.has(s.username);
        return true;
      }),
    [students, q, studentFilter, joinedUsernames]
  );

  const resettable = (s: Session) => s.locked || s.strikes > 0;
  const visibleResettable = visibleSessions.filter(resettable);
  const allVisibleSelected =
    visibleResettable.length > 0 &&
    visibleResettable.every((s) => selected.has(s.id));

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(key === "username");
    }
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleResettable.forEach((s) => next.delete(s.id));
      else visibleResettable.forEach((s) => next.add(s.id));
      return next;
    });

  const resetMany = async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const batch = writeBatch(db);
        ids.slice(i, i + 400).forEach((id) =>
          batch.update(doc(db, "sessions", id), { strikes: 0, locked: false })
        );
        await batch.commit();
      }
      setSelected(new Set());
      setNotice({
        text: `Reset ${ids.length} session${ids.length === 1 ? "" : "s"}.`,
      });
    } catch {
      setNotice({ text: "Reset failed. Check your connection and try again.", error: true });
    } finally {
      setBusy(false);
    }
  };

  const resetAllFlagged = () => {
    const ids = sessions.filter(resettable).map((s) => s.id);
    if (ids.length === 0) return;
    if (
      window.confirm(
        `Reset violations and unlock ${ids.length} session${ids.length === 1 ? "" : "s"}?`
      )
    )
      resetMany(ids);
  };

  const openFilter = (f: SessionFilter) => {
    setTab("sessions");
    setSessionFilter(f);
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ↑" : " ↓") : "";

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin" />

      <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        {/* Top bar: events + global action */}
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
          <div>
            <h1 className="text-lg font-semibold text-[#101828]">Control room</h1>
            <p className="text-sm text-slate-600">
              Live view of student sessions and event controls.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/admin/typing"
              className={`rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 ${focusRing}`}
            >
              Typing event
            </Link>
            <button
              onClick={resetAllFlagged}
              disabled={busy || stats.locked + stats.flagged === 0}
              className={`rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 ${focusRing}`}
            >
              Reset all violations
            </button>
          </div>
        </section>

        {/* Stat tiles double as filter shortcuts */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Students"
            value={studentsLoaded ? stats.total : "-"}
            hint="Seeded accounts"
            onClick={() => {
              setTab("students");
              setStudentFilter("all");
            }}
          />
          <StatTile
            label="Joined"
            value={sessionsLoaded ? stats.joined : "-"}
            hint={
              studentsLoaded && sessionsLoaded
                ? `${Math.max(stats.total - stats.joined, 0)} not joined yet`
                : ""
            }
            onClick={() => openFilter("all")}
          />
          <StatTile
            label="Locked"
            value={sessionsLoaded ? stats.locked : "-"}
            hint="Need an admin reset"
            tone={stats.locked > 0 ? "danger" : "neutral"}
            onClick={() => openFilter("locked")}
          />
          <StatTile
            label="With violations"
            value={sessionsLoaded ? stats.flagged : "-"}
            hint="Not locked yet"
            tone={stats.flagged > 0 ? "warn" : "neutral"}
            onClick={() => openFilter("flagged")}
          />
        </section>

        {/* Main panel */}
        <section className="rounded-xl border border-slate-200 bg-white">
          {/* Tabs + search */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div className="flex gap-1" role="tablist">
              <TabButton active={tab === "sessions"} onClick={() => setTab("sessions")}>
                Sessions ({sessions.length})
              </TabButton>
              <TabButton active={tab === "students"} onClick={() => setTab("students")}>
                Students ({students.length})
              </TabButton>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search username or name"
                aria-label="Search"
                className={`w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 ${focusRing}`}
              />
            </div>
          </div>

          {tab === "sessions" ? (
            <>
              {/* Filters + bulk action */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["all", "All", sessions.length],
                      ["locked", "Locked", stats.locked],
                      ["flagged", "Violations", stats.flagged],
                      [
                        "clean",
                        "Clean",
                        sessions.length - stats.locked - stats.flagged,
                      ],
                    ] as [SessionFilter, string, number][]
                  ).map(([key, label, count]) => (
                    <Chip
                      key={key}
                      active={sessionFilter === key}
                      onClick={() => setSessionFilter(key)}
                    >
                      {label} <span className="text-slate-400">{count}</span>
                    </Chip>
                  ))}
                </div>
                <button
                  onClick={() => resetMany([...selected])}
                  disabled={selected.size === 0 || busy}
                  className={`rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-30 ${focusRing}`}
                >
                  {busy
                    ? "Resetting..."
                    : selected.size > 0
                    ? `Reset selected (${selected.size})`
                    : "Reset selected"}
                </button>
              </div>

              {!sessionsLoaded ? (
                <Empty>Loading sessions...</Empty>
              ) : sessions.length === 0 ? (
                <Empty>
                  No student has opened the app yet. Sessions appear here as soon
                  as someone signs in.
                </Empty>
              ) : visibleSessions.length === 0 ? (
                <Empty>No sessions match this search or filter.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-y border-slate-200 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="w-10 py-2 pl-4">
                          <input
                            type="checkbox"
                            aria-label="Select all resettable sessions"
                            checked={allVisibleSelected}
                            disabled={visibleResettable.length === 0}
                            onChange={toggleAllVisible}
                            className={focusRing}
                          />
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          <button onClick={() => toggleSort("username")} className={focusRing}>
                            Student{sortArrow("username")}
                          </button>
                        </th>
                        <th className="py-2 pr-4 font-medium">
                          <button onClick={() => toggleSort("strikes")} className={focusRing}>
                            Violations{sortArrow("strikes")}
                          </button>
                        </th>
                        <th className="py-2 pr-4 font-medium">Status</th>
                        <th className="py-2 pr-4 font-medium">Last reason</th>
                        <th className="py-2 pr-4" />
                      </tr>
                    </thead>
                    <tbody className="text-slate-700">
                      {visibleSessions.map((s) => (
                        <tr
                          key={s.id}
                          className={`border-b border-slate-100 ${
                            s.locked ? "bg-red-50/60" : ""
                          }`}
                        >
                          <td className="py-2.5 pl-4">
                            {resettable(s) && (
                              <input
                                type="checkbox"
                                aria-label={`Select ${s.username}`}
                                checked={selected.has(s.id)}
                                onChange={() => toggleOne(s.id)}
                                className={focusRing}
                              />
                            )}
                          </td>
                          <td className="py-2.5 pr-4">
                            <div className="font-medium text-[#101828]">{s.username}</div>
                            {s.name && s.name !== s.username && (
                              <div className="text-xs text-slate-500">{s.name}</div>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 tabular-nums">{s.strikes}</td>
                          <td className="py-2.5 pr-4">
                            <StatusBadge locked={s.locked} strikes={s.strikes} />
                          </td>
                          <td className="max-w-xs truncate py-2.5 pr-4 text-slate-600">
                            {s.lastReason ?? "-"}
                          </td>
                          <td className="py-2.5 pr-4 text-right">
                            {resettable(s) && (
                              <button
                                onClick={() => resetMany([s.id])}
                                disabled={busy}
                                className={`rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-40 ${focusRing}`}
                              >
                                Reset
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 px-4 py-3">
                {(
                  [
                    ["all", "All", students.length],
                    ["joined", "Joined", students.filter((s) => joinedUsernames.has(s.username)).length],
                    ["waiting", "Not joined", students.filter((s) => !joinedUsernames.has(s.username)).length],
                  ] as [StudentFilter, string, number][]
                ).map(([key, label, count]) => (
                  <Chip
                    key={key}
                    active={studentFilter === key}
                    onClick={() => setStudentFilter(key)}
                  >
                    {label} <span className="text-slate-400">{count}</span>
                  </Chip>
                ))}
              </div>

              {!studentsLoaded ? (
                <Empty>Loading students...</Empty>
              ) : students.length === 0 ? (
                <Empty>
                  No students yet. Run <code>node scripts/seed.mjs</code> to
                  create accounts.
                </Empty>
              ) : visibleStudents.length === 0 ? (
                <Empty>No students match this search or filter.</Empty>
              ) : (
                <ul className="grid grid-cols-2 gap-2 border-t border-slate-200 p-4 sm:grid-cols-3 lg:grid-cols-5">
                  {visibleStudents.map((s) => {
                    const joined = joinedUsernames.has(s.username);
                    return (
                      <li
                        key={s.id}
                        className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700"
                        title={s.name}
                      >
                        <span
                          aria-hidden
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            joined ? "bg-teal-600" : "bg-slate-300"
                          }`}
                        />
                        <span className="truncate">{s.username}</span>
                        <span className="sr-only">{joined ? "joined" : "not joined"}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      </main>

      {/* Toast */}
      {notice && (
        <div
          role="status"
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-lg ${
            notice.error ? "bg-red-700" : "bg-slate-900"
          }`}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}

/* ---------- small components ---------- */

function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  onClick,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "neutral" | "warn" | "danger";
  onClick: () => void;
}) {
  const accent =
    tone === "danger"
      ? "border-l-red-600"
      : tone === "warn"
      ? "border-l-amber-500"
      : "border-l-teal-700";
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border border-l-4 border-slate-200 bg-white p-4 text-left hover:bg-slate-50 ${accent} ${focusRing}`}
    >
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums text-[#101828]">
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </button>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium ${focusRing} ${
        active
          ? "bg-teal-700 text-white"
          : "text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${focusRing} ${
        active
          ? "border-teal-700 bg-teal-50 text-teal-800"
          : "border-slate-300 text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function StatusBadge({ locked, strikes }: { locked: boolean; strikes: number }) {
  if (locked)
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
        Locked
      </span>
    );
  if (strikes > 0)
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        Warned
      </span>
    );
  return (
    <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800">
      OK
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-t border-slate-200 px-4 py-10 text-center text-sm text-slate-600">
      {children}
    </p>
  );
}