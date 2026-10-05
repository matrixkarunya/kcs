import { NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, unknown> = {
    env: {
      FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
      FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
      FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    },
  };
  try {
    const db = adminDb();
    const pool = await db.doc("config/typingPool").get();
    out.firestore = "ok";
    out.poolExists = pool.exists;
    out.passageCount = (pool.data()?.passages ?? []).length;
    const cfg = await db.doc("config/typing").get();
    out.configExists = cfg.exists;
    out.status = cfg.data()?.status ?? null;
  } catch (e) {
    out.firestore = "FAILED";
    out.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  return NextResponse.json(out);
}