"use client";

import { useEffect, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  updateDoc,
  where,
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

export default function AdminPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    getDocs(query(collection(db, "users"), where("role", "==", "student")))
      .then((snap) => {
        const rows = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Student, "id">),
        }));
        rows.sort((a, b) => a.username.localeCompare(b.username));
        setStudents(rows);
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    return onSnapshot(collection(db, "sessions"), (snap) => {
      const rows = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Session, "id">),
      }));
      rows.sort((a, b) => a.username.localeCompare(b.username));
      setSessions(rows);
    });
  }, []);

  const reset = (id: string) =>
    updateDoc(doc(db, "sessions", id), { strikes: 0, locked: false });

  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Admin" />
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
  <h2 className="font-semibold text-[#101828]">Events</h2>
  <div className="mt-3 flex gap-3">
    <Link
      href="/admin/typing"
      className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800"
    >
      Typing
    </Link>
  </div>
</section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-[#101828]">
            Live sessions ({sessions.length})
          </h2>
          {sessions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">
              No student has opened the app yet.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-slate-500">
                  <tr>
                    <th className="py-1 pr-4 font-medium">Student</th>
                    <th className="py-1 pr-4 font-medium">Violations</th>
                    <th className="py-1 pr-4 font-medium">Status</th>
                    <th className="py-1 pr-4 font-medium">Last reason</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody className="text-slate-700">
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-t border-slate-100">
                      <td className="py-2 pr-4">{s.username}</td>
                      <td className="py-2 pr-4">{s.strikes}</td>
                      <td
                        className={`py-2 pr-4 ${
                          s.locked ? "font-medium text-red-700" : ""
                        }`}
                      >
                        {s.locked ? "Locked" : "OK"}
                      </td>
                      <td className="py-2 pr-4">{s.lastReason ?? "-"}</td>
                      <td className="py-2 text-right">
                        {(s.locked || s.strikes > 0) && (
                          <button
                            onClick={() => reset(s.id)}
                            className="rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100"
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
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-[#101828]">
            Students {loaded && `(${students.length})`}
          </h2>
          {loaded && students.length === 0 && (
            <p className="mt-2 text-sm text-slate-600">
              No students yet. Run the seed script.
            </p>
          )}
          <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-4">
            {students.map((s) => (
              <li key={s.id}>{s.username}</li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}