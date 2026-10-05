"use client";

import { useEffect, useRef, useState } from "react";
import { useProctor } from "@/lib/proctor";

export interface FinishPayload {
  typed: string;
  times: number[];
  untrusted: number;
  elapsedMs: number;
}

interface Props {
  passage: string;
  durationMs: number;
  label: string;
  onFinish: (p: FinishPayload) => void;
}

export default function TypingTest({
  passage,
  durationMs,
  label,
  onFinish,
}: Props) {
  const { phase } = useProctor();
  const [typed, setTyped] = useState("");
  const [remaining, setRemaining] = useState(durationMs);

  const typedRef = useRef("");
  const timesRef = useRef<number[]>([]);
  const untrustedRef = useRef(0);
  const t0Ref = useRef(0);
  const doneRef = useRef(false);
  const phaseRef = useRef(phase);
  const onFinishRef = useRef(onFinish);
  const boxRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    t0Ref.current = performance.now();

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      const times = timesRef.current;
      const complete = typedRef.current.length >= passage.length;
      onFinishRef.current({
        typed: typedRef.current,
        times,
        untrusted: untrustedRef.current,
        elapsedMs: complete
          ? Math.max(times[times.length - 1] ?? 0, 1000)
          : durationMs,
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (doneRef.current || phaseRef.current !== "active") return;
      if (e.ctrlKey || e.metaKey) return;
      if (e.key === "Backspace" || e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        return;
      }
      if (e.key.length !== 1) return;
      e.preventDefault();
      if (e.repeat) return;
      if (!e.isTrusted) {
        untrustedRef.current++;
        return;
      }
      const t = Math.round(performance.now() - t0Ref.current);
      if (t > durationMs) {
        finish();
        return;
      }
      typedRef.current += e.key;
      timesRef.current.push(t);
      setTyped(typedRef.current);
      if (typedRef.current.length >= passage.length) finish();
    };

    const id = setInterval(() => {
      const left = durationMs - (performance.now() - t0Ref.current);
      if (left <= 0) {
        setRemaining(0);
        finish();
      } else {
        setRemaining(left);
      }
    }, 100);

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearInterval(id);
    };
  }, [passage, durationMs]);

  // keep the current character in the middle of the box
  useEffect(() => {
    const box = boxRef.current;
    const cur = curRef.current;
    if (box && cur) box.scrollTop = cur.offsetTop - box.clientHeight / 2;
  }, [typed]);

  // ---- live stats (display only, the server does the real scoring) ----
  const n = typed.length;
  let errors = 0;
  for (let i = 0; i < n; i++) if (typed[i] !== passage[i]) errors++;
  const elapsedMs = durationMs - remaining;
  const mins = Math.max(elapsedMs, 1000) / 60000;
  const liveWpm = n === 0 ? 0 : Math.max(0, Math.round((n / 5 - errors) / mins));
  const accuracy = n === 0 ? 100 : Math.round(((n - errors) / n) * 100);
  const progress = Math.min(100, Math.round((n / passage.length) * 100));
  const timePct = Math.max(0, Math.min(100, (remaining / durationMs) * 100));
  const urgent = remaining <= 10_000;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </p>
        <p
          className={`rounded-full px-4 py-1 text-2xl font-bold tabular-nums ring-1 ${
            urgent
              ? "bg-rose-50 text-rose-600 ring-rose-200"
              : "bg-teal-50 text-teal-700 ring-teal-200"
          }`}
        >
          {Math.ceil(remaining / 1000)}s
        </p>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-[width] duration-100 ease-linear ${
            urgent
              ? "bg-linear-to-r from-rose-500 to-orange-400"
              : "bg-linear-to-r from-teal-500 to-emerald-400"
          }`}
          style={{ width: `${timePct}%` }}
        />
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-3">
        {[
          ["WPM", liveWpm],
          ["Accuracy", `${accuracy}%`],
          ["Progress", `${progress}%`],
        ].map(([k, v]) => (
          <div
            key={k}
            className="rounded-xl bg-slate-50 px-4 py-2.5 ring-1 ring-slate-200/70"
          >
            <dt className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
              {k}
            </dt>
            <dd className="text-xl font-bold tabular-nums text-slate-900">
              {v}
            </dd>
          </div>
        ))}
      </dl>

      <div className="relative mt-4">
        <div
          ref={boxRef}
          className="relative h-56 overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 font-mono text-xl leading-10 shadow-inner"
        >
          {passage.split("").map((ch, i) => {
            let cls = "text-slate-400";
            if (i < n) {
              cls =
                typed[i] === ch
                  ? "text-slate-900"
                  : "rounded-sm bg-rose-100 text-rose-700";
            } else if (i === n) {
              cls =
                "rounded-sm bg-teal-100 text-slate-900 border-b-2 border-teal-600";
            }
            return (
              <span key={i} ref={i === n ? curRef : undefined} className={cls}>
                {ch}
              </span>
            );
          })}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-0 h-8 rounded-t-2xl bg-linear-to-b from-white to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-2xl bg-linear-to-t from-white to-transparent" />
      </div>

      <p className="mt-3 text-sm text-slate-600">
        Just start typing. There is no backspace, so every key counts.
      </p>
    </div>
  );
}