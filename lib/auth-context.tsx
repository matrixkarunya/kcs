"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "./firebase";

export type Role = "admin" | "student";

export interface Profile {
  uid: string;
  username: string;
  name: string;
  role: Role;
  teamId?: string | null;
}

// Firebase Auth needs an email, so a username maps to a fake one.
export const usernameToEmail = (username: string) =>
  `${username.trim().toLowerCase()}@matrix-events.app`;

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<Profile>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchProfile(uid: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return null;
  return { uid, ...(snap.data() as Omit<Profile, "uid">) };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setProfile(u ? await fetchProfile(u.uid).catch(() => null) : null);
      setLoading(false);
    });
  }, []);

  const login = async (username: string, password: string) => {
    const cred = await signInWithEmailAndPassword(
      auth,
      usernameToEmail(username),
      password
    );
    const p = await fetchProfile(cred.user.uid);
    if (!p) {
      await signOut(auth);
      throw new Error("no-profile");
    }
    setProfile(p);
    return p;
  };

  const logout = async () => {
    await signOut(auth);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}