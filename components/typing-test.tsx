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

export default function TypingTest({ passage, durationMs, label, onFinish }: Props) {
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

  const n = typed.length;

  return (
    <div className="select-none">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-semibold text-[#101828]">{label}</p>
        <p className="text-2xl font-bold tabular-nums text-teal-700">
          {Math.ceil(remaining / 1000)}s
        </p>
      </div>
      <div
        ref={boxRef}
        className="relative h-52 overflow-hidden rounded-xl border border-slate-200 bg-white p-5 font-mono text-xl leading-10"
      >
        {passage.split("").map((ch, i) => {
          let cls = "text-slate-400";
          if (i < n) {
            cls = typed[i] === ch ? "text-[#101828]" : "bg-red-100 text-red-700";
          } else if (i === n) {
            cls = "bg-teal-100 text-[#101828]";
          }
          return (
            <span key={i} ref={i === n ? curRef : undefined} className={cls}>
              {ch}
            </span>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-slate-600">
        Just start typing. There is no backspace, so every key counts.
      </p>
    </div>
  );
}