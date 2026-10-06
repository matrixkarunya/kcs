"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import AppHeader from "@/components/app-header";
import { useAuth } from "@/lib/auth-context";

interface EventItem {
  name: string;
  blurb: string;
  href?: string;
  icon: ReactNode;
}

const iconProps = {
  viewBox: "0 0 24 24",
  className: "h-6 w-6",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const EVENTS: EventItem[] = [
  {
    name: "Typing",
    blurb: "Race the clock. One scored attempt, plus 3 practice runs.",
    href: "/students/typing",
    icon: (
      <svg {...iconProps}>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
      </svg>
    ),
  },
  {
    name: "Code Relay",
    blurb: "Pass the baton and solve problems as a team.",
    icon: (
      <svg {...iconProps}>
        <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
      </svg>
    ),
  },
  {
    name: "Prompt Challenge",
    blurb: "Write the sharpest prompt and beat the leaderboard.",
    icon: (
      <svg {...iconProps}>
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
      </svg>
    ),
  },
];

export default function StudentsPage() {
  const { profile } = useAuth();
  const firstName = profile?.name?.split(" ")[0];
  const openCount = EVENTS.filter((e) => e.href).length;

  return (
    <div className="min-h-screen bg-linear-to-br from-slate-50 via-[#eef2f6] to-teal-50/70">
      <AppHeader title="Matrix Events" />
      <main className="mx-auto max-w-3xl space-y-8 p-6">
       

        <section aria-labelledby="events-heading">
          <h2
            id="events-heading"
            className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500"
          >
            Events
          </h2>
          <ul className="space-y-3">
            {EVENTS.map((e) => {
              const inner = (
                <>
                  <span
                    className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl ring-1 ${
                      e.href
                        ? "bg-linear-to-br from-teal-50 to-emerald-50 text-teal-700 ring-teal-200"
                        : "bg-slate-100 text-slate-400 ring-slate-200"
                    }`}
                  >
                    {e.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block font-semibold ${
                        e.href ? "text-slate-900" : "text-slate-700"
                      }`}
                    >
                      {e.name}
                    </span>
                    <span className="mt-0.5 block text-sm text-slate-500">
                      {e.blurb}
                    </span>
                  </span>
                  {e.href ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-teal-700 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition group-hover:bg-teal-600">
                      Open <span aria-hidden="true">→</span>
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      Not open yet
                    </span>
                  )}
                </>
              );

              const base =
                "flex items-center gap-4 rounded-2xl border border-white/70 bg-white/85 p-5 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5 backdrop-blur";

              return (
                <li key={e.name}>
                  {e.href ? (
                    <Link
                      href={e.href}
                      className={`${base} group transition hover:-translate-y-0.5 hover:ring-teal-600/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className={`${base} opacity-80`} aria-disabled="true">
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </main>
    </div>
  );
}