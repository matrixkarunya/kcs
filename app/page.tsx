"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

const inputCls =
  "w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-11 pr-3 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-teal-600 focus:ring-4 focus:ring-teal-600/15";

export default function LoginPage() {
  const { profile, loading, login } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && profile) {
      router.replace(profile.role === "admin" ? "/admin" : "/students");
    }
  }, [loading, profile, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const p = await login(username, password);
      router.replace(p.role === "admin" ? "/admin" : "/students");
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? "";
      const msg = (err as { message?: string })?.message ?? "";
      if (msg === "no-profile") {
        setError("This account isn't set up for the event. Ask an organiser.");
      } else if (
        code === "auth/invalid-credential" ||
        code === "auth/user-not-found" ||
        code === "auth/wrong-password"
      ) {
        setError("Wrong username or password.");
      } else if (code === "auth/too-many-requests") {
        setError("Too many attempts. Wait a minute and try again.");
      } else {
        setError("Couldn't sign in. Check your connection and try again.");
      }
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-linear-to-br from-slate-50 via-[#eef2f6] to-teal-50/70 px-4">
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-teal-400/20 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-emerald-400/20 blur-3xl"
        aria-hidden="true"
      />

      <div className="relative w-full max-w-sm">
        <div className="text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-linear-to-br from-teal-600 to-emerald-500 text-white shadow-lg shadow-teal-700/30">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <h1 className="mt-5 text-3xl font-extrabold tracking-tight text-slate-900">
            KCS x MATRIX
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            Sign in with the username and password on your slip.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="mt-8 space-y-5 rounded-2xl border border-white/70 bg-white/85 p-6 shadow-[0_20px_50px_-15px_rgba(15,23,42,0.18)] ring-1 ring-slate-900/5 backdrop-blur"
        >
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              Username
            </span>
            <span className="relative block">
              <svg
                viewBox="0 0 24 24"
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                className={inputCls}
              />
            </span>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              Password
            </span>
            <span className="relative block">
              <svg
                viewBox="0 0 24 24"
                className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className={`${inputCls} pr-16`}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-pressed={showPw}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-semibold text-teal-800 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-teal-700"
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </span>
          </label>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700"
            >
              {error}
            </div>
          )}

          <button
            disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-linear-to-b from-teal-600 to-teal-700 py-2.5 font-semibold text-white shadow-md shadow-teal-700/20 transition hover:from-teal-500 hover:to-teal-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && (
              <span
                className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden="true"
              />
            )}
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500">
          Trouble signing in? Ask an organiser.
        </p>
      </div>
    </main>
  );
}