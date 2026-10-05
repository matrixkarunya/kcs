"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";

export const MAX_STRIKES = 3;
const ARMED_KEY = "proctor_armed";

export type Phase = "loading" | "gate" | "warning" | "active" | "locked";

interface ProctorValue {
  phase: Phase;
  strikes: number;
  maxStrikes: number;
  enterFullscreen: () => Promise<void>;
  disarm: () => Promise<void>;
}

export const ProctorContext = createContext<ProctorValue | null>(null);

export function useProctor() {
  const ctx = useContext(ProctorContext);
  if (!ctx) throw new Error("useProctor must be used inside <ProctorProvider>");
  return ctx;
}

export function ProctorProvider({ children }: { children: ReactNode }) {
  const { profile, logout } = useAuth();
  const router = useRouter();
  const uid = profile?.uid;

  const [loaded, setLoaded] = useState(false);
  const [strikes, setStrikes] = useState(0);
  const [locked, setLocked] = useState(false);
  const [inFs, setInFs] = useState(false);
  const [pendingReason, setPendingReason] = useState<string | null>(null);
  const [fsError, setFsError] = useState("");

  const armedRef = useRef(false); // true once the student has entered full screen
  const incidentRef = useRef(false); // true while a violation awaits acknowledgement
  const lockedRef = useRef(false);
  const strikesRef = useRef(0);
  const loadedRef = useRef(false);

  // Live session doc: strikes + locked (so an admin reset applies instantly)
  useEffect(() => {
    if (!uid || !profile) return;
    const ref = doc(db, "sessions", uid);
    return onSnapshot(ref, (snap) => {
      if (!snap.exists()) {
        setDoc(ref, {
          uid,
          username: profile.username,
          name: profile.name,
          strikes: 0,
          locked: false,
          createdAt: serverTimestamp(),
        }).catch(console.error);
        return;
      }
      const d = snap.data();
      const s = (d.strikes ?? 0) as number;
      const l = !!d.locked;
      if (lockedRef.current && !l) {
        incidentRef.current = false;
        setPendingReason(null);
      }
      strikesRef.current = s;
      lockedRef.current = l;
      loadedRef.current = true;
      setStrikes(s);
      setLocked(l);
      setLoaded(true);
    });
  }, [uid, profile]);

  const report = useCallback(
    (reason: string) => {
      if (
        !uid ||
        !armedRef.current ||
        !loadedRef.current ||
        lockedRef.current ||
        incidentRef.current
      )
        return;
      incidentRef.current = true;
      setPendingReason(reason);

      const next = strikesRef.current + 1;
      const nowLocked = next >= MAX_STRIKES;
      strikesRef.current = next;
      lockedRef.current = nowLocked;
      setStrikes(next);
      setLocked(nowLocked);

      const ref = doc(db, "sessions", uid);
      setDoc(
        ref,
        {
          strikes: next,
          locked: nowLocked,
          lastReason: reason,
          lastViolationAt: serverTimestamp(),
        },
        { merge: true }
      ).catch(console.error);
      addDoc(collection(ref, "violations"), {
        reason,
        strike: next,
        at: serverTimestamp(),
      }).catch(console.error);
    },
    [uid]
  );

  // Detection + blocking
  useEffect(() => {
    const onFs = () => {
      const fs = !!document.fullscreenElement;
      setInFs(fs);
      if (!fs) report("Exited full screen");
    };
    const onVis = () => {
      if (document.hidden) report("Switched tab or minimised the window");
    };
    const onBlur = () => report("Clicked outside the exam window");
    const stop = (e: Event) => e.preventDefault();
    const onSelect = (e: Event) => {
      const el =
        e.target instanceof Element ? e.target : (e.target as Node)?.parentElement;
      if (el?.closest("input,textarea,[data-allow-select]")) return;
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      const devtools =
        e.key === "F12" ||
        (mod && e.shiftKey && ["i", "j", "c"].includes(k)) ||
        (mod && k === "u");
      if (devtools) {
        e.preventDefault();
        report("Tried to open developer tools");
        return;
      }
      if (mod && ["c", "x", "v", "s", "p"].includes(k)) e.preventDefault();
    };

    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    document.addEventListener("copy", stop);
    document.addEventListener("cut", stop);
    document.addEventListener("paste", stop);
    document.addEventListener("contextmenu", stop);
    document.addEventListener("dragstart", stop);
    document.addEventListener("selectstart", onSelect);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("copy", stop);
      document.removeEventListener("cut", stop);
      document.removeEventListener("paste", stop);
      document.removeEventListener("contextmenu", stop);
      document.removeEventListener("dragstart", stop);
      document.removeEventListener("selectstart", onSelect);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [report]);

  // Reload while armed: full screen is lost on reload, so count it
  useEffect(() => {
    if (!loaded) return;
    setInFs(!!document.fullscreenElement);
    if (sessionStorage.getItem(ARMED_KEY) === "1") {
      armedRef.current = true;
      if (!document.fullscreenElement) {
        report("Page reloaded or full screen was lost");
      }
    }
  }, [loaded, report]);

  // When locked, release the student from full screen
  useEffect(() => {
    if (locked && document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }, [locked]);

  const enterFullscreen = useCallback(async () => {
    setFsError("");
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      }
      // Chrome/Edge: makes a single Esc press not exit full screen
      (
        navigator as unknown as {
          keyboard?: { lock?: (keys: string[]) => Promise<void> };
        }
      ).keyboard
        ?.lock?.(["Escape"])
        ?.catch(() => {});
      armedRef.current = true;
      incidentRef.current = false;
      sessionStorage.setItem(ARMED_KEY, "1");
      setPendingReason(null);
      setInFs(true);
    } catch {
      setFsError(
        "Your browser blocked full screen. Use desktop Chrome or Edge and try again."
      );
    }
  }, []);

  // Call before signing out so leaving on purpose is not a violation
  const disarm = useCallback(async () => {
    armedRef.current = false;
    sessionStorage.removeItem(ARMED_KEY);
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => {});
    }
  }, []);

  const phase: Phase = !loaded
    ? "loading"
    : locked
    ? "locked"
    : pendingReason
    ? "warning"
    : inFs
    ? "active"
    : "gate";

  const remaining = MAX_STRIKES - strikes;

  return (
    <ProctorContext.Provider
      value={{ phase, strikes, maxStrikes: MAX_STRIKES, enterFullscreen, disarm }}
    >
      {children}

      {phase === "active" && strikes > 0 && (
        <div className="fixed right-3 top-3 z-40 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900">
          Warnings: {strikes}/{MAX_STRIKES}
        </div>
      )}

      {phase !== "active" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#eef2f6] px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            {phase === "loading" && (
              <p className="text-sm text-slate-600">Loading…</p>
            )}

            {phase === "gate" && (
              <>
                <h1 className="text-xl font-semibold text-[#101828]">
                  Full screen is required
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  You must stay in full screen for the whole event. These count
                  as a violation: leaving full screen, switching tabs or windows,
                  reloading the page, or opening developer tools. After{" "}
                  {MAX_STRIKES} violations you are locked out.
                </p>
                {strikes > 0 && (
                  <p className="mt-2 text-sm font-medium text-amber-800">
                    Violations so far: {strikes} of {MAX_STRIKES}.
                  </p>
                )}
                {fsError && (
                  <p role="alert" className="mt-2 text-sm text-red-700">
                    {fsError}
                  </p>
                )}
                <button
                  onClick={enterFullscreen}
                  className="mt-4 w-full rounded-md bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                >
                  Enter full screen
                </button>
              </>
            )}

            {phase === "warning" && (
              <>
                <h1 className="text-xl font-semibold text-amber-800">
                  Warning {strikes} of {MAX_STRIKES}
                </h1>
                <p className="mt-2 text-sm text-slate-700">{pendingReason}.</p>
                <p className="mt-1 text-sm text-slate-600">
                  {remaining} more {remaining === 1 ? "violation" : "violations"}{" "}
                  and you are locked out.
                </p>
                {fsError && (
                  <p role="alert" className="mt-2 text-sm text-red-700">
                    {fsError}
                  </p>
                )}
                <button
                  onClick={enterFullscreen}
                  className="mt-4 w-full rounded-md bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
                >
                  Return to full screen
                </button>
              </>
            )}

            {phase === "locked" && (
              <>
                <h1 className="text-xl font-semibold text-red-800">
                  You are locked out
                </h1>
                <p className="mt-2 text-sm text-slate-600">
                  You reached {MAX_STRIKES} violations. Tell an organiser, who can
                  reset your session.
                </p>
                <button
                  onClick={async () => {
                    await disarm();
                    await logout();
                    router.replace("/");
                  }}
                  className="mt-4 w-full rounded-md border border-slate-300 py-2 text-slate-700 hover:bg-slate-100"
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </ProctorContext.Provider>
  );
}