import { NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { ApiError, errorResponse, requireStudent } from "@/lib/api-auth";
import { analyzeTiming, getPassageById } from "@/lib/typing-server";
import { detailTyping, scoreTyping } from "@/lib/typing";

export const dynamic = "force-dynamic";

function validTimes(times: unknown, n: number): times is number[] {
  if (!Array.isArray(times) || times.length !== n) return false;
  let prev = 0;
  for (const t of times) {
    if (typeof t !== "number" || !Number.isFinite(t) || t < prev) return false;
    prev = t;
  }
  return true;
}

export async function POST(req: Request) {
  try {
    const user = await requireStudent(req);
    const body = (await req.json()) as Record<string, unknown>;
    const { roundId, typed, times } = body;
    const untrusted = Number(body.untrusted ?? 0);
    if (
      typeof roundId !== "string" ||
      typeof typed !== "string" ||
      typed.length > 6000 ||
      !validTimes(times, typed.length)
    ) {
      throw new ApiError(400, "bad-request");
    }

    const db = adminDb();
    const ref = db.doc(`typingAttempts/${roundId}_${user.uid}`);
    const snap = await ref.get();
    if (!snap.exists) throw new ApiError(404, "no-attempt");
    const attempt = snap.data()!;
    if (attempt.status !== "started") throw new ApiError(409, "already-submitted");

    const passage = await getPassageById(attempt.passageId);
    if (!passage) throw new ApiError(500, "passage-missing");
    if (typed.length > passage.text.length) throw new ApiError(400, "too-long");

    const durationMs = (attempt.durationSec as number) * 1000;
    const nowMs = Date.now();
    const serverElapsed = nowMs - (attempt.startedAt as Timestamp).toMillis();

    const flags: string[] = [];

    // ignore anything typed after the time ran out
    let keep = times.length;
    while (keep > 0 && times[keep - 1] > durationMs + 250) keep--;
    if (keep < times.length) flags.push("time-overrun");
    const typedKept = typed.slice(0, keep);
    const timesKept = times.slice(0, keep);

    const finished = typedKept.length === passage.text.length;
    const lastT = timesKept.length ? timesKept[timesKept.length - 1] : 0;
    const elapsedMs = finished ? Math.max(lastT, 1000) : durationMs;

    if (lastT > serverElapsed + 2000) flags.push("clock-mismatch");
    if (serverElapsed > durationMs + 8000) flags.push("late-submit");
    if (untrusted > 0) flags.push("synthetic-events");
    flags.push(...analyzeTiming(timesKept));

    const score = scoreTyping(passage.text, typedKept, elapsedMs);
    if (score.grossWpm > 180) flags.push("very-high-wpm");

    // extra detail for the admin dashboard (never sent to the student)
    const detail = detailTyping(passage.text, typedKept, timesKept, durationMs);

    const strikes =
      (await db.doc(`sessions/${user.uid}`).get()).data()?.strikes ?? 0;

    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (cur.data()?.status !== "started") {
        throw new ApiError(409, "already-submitted");
      }
      tx.update(ref, {
        status: "submitted",
        submittedAt: Timestamp.fromMillis(nowMs),
        ...score,
        ...detail,
        flags,
        review: flags.length ? "flagged" : "valid",
        strikes,
      });
    });

    // flags and detail are never sent back to the student
    return NextResponse.json(score);
  } catch (e) {
    return errorResponse(e);
  }
}