import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { ApiError, errorResponse, requireStudent } from "@/lib/api-auth";
import { getPool } from "@/lib/typing-server";
import { COUNTDOWN_MS } from "@/lib/typing";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const user = await requireStudent(req);
    const { roundId } = (await req.json()) as { roundId?: string };
    if (typeof roundId !== "string") throw new ApiError(400, "bad-request");

    const db = adminDb();
    const cfg = (await db.doc("config/typing").get()).data();
    if (!cfg || cfg.status !== "running" || cfg.roundId !== roundId || !cfg.startedAt) {
      throw new ApiError(409, "round-not-running");
    }
    const startsAt = (cfg.startedAt as Timestamp).toMillis() + COUNTDOWN_MS;
    if (Date.now() < startsAt - 1500) throw new ApiError(425, "too-early");

    const pool = await getPool();
    if (pool.length === 0) throw new ApiError(500, "no-passages");
    const passage = pool[Math.floor(Math.random() * pool.length)];

    const profile = (await db.doc(`users/${user.uid}`).get()).data();
    const startedAtMs = Date.now();
    try {
      await db.doc(`typingAttempts/${roundId}_${user.uid}`).create({
        uid: user.uid,
        roundId,
        username: profile?.username ?? "",
        name: profile?.name ?? "",
        passageId: passage.id,
        durationSec: cfg.durationSec,
        startedAt: Timestamp.fromMillis(startedAtMs),
        status: "started",
      });
    } catch (e) {
      if ((e as { code?: number }).code === 6) {
        throw new ApiError(409, "already-attempted");
      }
      throw e;
    }

    return NextResponse.json({
      passage: passage.text,
      durationSec: cfg.durationSec as number,
    });
  } catch (e) {
    return errorResponse(e);
  }
}