"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";

export default function LoginPage() {
  const { profile, loading, login } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
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
    <main className="flex min-h-screen items-center justify-center bg-[#eef2f6] px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold tracking-tight text-[#101828]">
          Matrix Events
        </h1>
        <p className="mt-1 mb-6 text-slate-600">
          Sign in with the username and password on your slip.
        </p>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Username
            </span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              className="w-full rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
            />
          </label>

          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}

          <button
            disabled={busy}
            className="w-full rounded-md bg-teal-700 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}