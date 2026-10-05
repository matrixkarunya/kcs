"use client";

import AppHeader from "@/components/app-header";

const EVENTS = ["Typing", "Code Relay", "Prompt Challenge"];

export default function StudentsPage() {
  return (
    <div className="min-h-screen bg-[#eef2f6]">
      <AppHeader title="Matrix Events" />
      <main className="mx-auto max-w-3xl space-y-3 p-6">
        {EVENTS.map((e) => (
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