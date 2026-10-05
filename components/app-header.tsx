"use client";

import { useContext } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ProctorContext } from "@/lib/proctor";

export default function AppHeader({ title }: { title: string }) {
  const { profile, logout } = useAuth();
  const proctor = useContext(ProctorContext); // null on admin pages
  const router = useRouter();

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
      <div>
        <p className="text-lg font-semibold text-[#101828]">{title}</p>
        <p className="text-sm text-slate-500">
          {profile?.name} ({profile?.username})
        </p>
      </div>
      <button
        onClick={async () => {
          await proctor?.disarm();
          await logout();
          router.replace("/");
        }}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700"
      >
        Sign out
      </button>
    </header>
  );
}