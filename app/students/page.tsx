"use client";

import Link from "next/link";
import AppHeader from "@/components/app-header";

export default function StudentsPage() {
  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Matrix Events" />
      <main className="mx-auto max-w-3xl space-y-3 p-6">
        <Link
          href="/students/typing"
          className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5 hover:border-teal-700"
        >
          <span className="font-medium text-[#101828]">Typing</span>
          <span className="text-sm text-teal-800">Open</span>
        </Link>
        {["Code Relay", "Prompt Challenge"].map((e) => (
          <div
            key={e}
            className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5"
          >
            <span className="font-medium text-[#101828]">{e}</span>
            <span className="text-sm text-slate-500">Not open yet</span>
          </div>
        ))}
      </main>
    </div>
  );
}