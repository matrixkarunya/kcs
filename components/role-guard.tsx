"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Role, useAuth } from "@/lib/auth-context";

export default function RoleGuard({
  role,
  children,
}: {
  role: Role;
  children: ReactNode;
}) {
  const { profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!profile) router.replace("/");
    else if (profile.role !== role)
      router.replace(profile.role === "admin" ? "/admin" : "/students");
  }, [loading, profile, role, router]);

  if (loading || !profile || profile.role !== role) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}