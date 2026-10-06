import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { ApiError, errorResponse, requireStudent } from "@/lib/api-auth";
import { getBank, signToken, verifyToken } from "@/lib/relay-server";
import { normalizeOutput } from "@/lib/relay";

export const dynamic = "force-dynamic";

const HANDOFF_MS = 5000; // pause between one member and the next
const MAX_JUDGE_MS = 60_000; // longest judging pause we will credit

interface Team {
  uid: string;
  memberNames: string[];
  order: string[];
  qIndex: number;
  holder: number;
  legStartedAt: Timestamp | null;
  solved: number;
  wrong: number;
  skipped?: number;
  bonusMs?: number; // time credited back (judging + handoffs)
  judgingSince?: Timestamp | null;
  status: "waiting" | "active" | "finished";
}
interface Cfg {
  status: string;
  startedAt: Timestamp | null;
  durationMin: number;
  legSec: number;
  minPassSec: number;
}
interface TokenPayload {
  teamId: string;
  qid: string;
  wrong: number;
  uid: string;
  iat: number;
}

// Credits the time spent judging back to the team (turn clock and round deadline).
function settleJudging(cur: Team, now: number) {
  const since = cur.judgingSince?.toMillis();
  const pause = since ? Math.max(0, Math.min(now - since, MAX_JUDGE_MS)) : 0;
  const upd: Record<string, unknown> = { judgingSince: null };
  if (pause > 0) {
    upd.bonusMs = (cur.bonusMs ?? 0) + pause;
    if (cur.legStartedAt) {
      upd.legStartedAt = Timestamp.fromMillis(cur.legStartedAt.toMillis() + pause);
    }
  }
  return upd;
}

export async function POST(req: Request) {
  try {
    const user = await requireStudent(req);
    const body = (await req.json()) as Record<string, unknown>;
    const { action, teamId } = body;
    if (typeof action !== "string" || typeof teamId !== "string") {
      throw new ApiError(400, "bad-request");
    }

    const db = adminDb();
    const teamRef = db.doc(`relayTeams/${teamId}`);
    const [teamSnap, cfgSnap] = await Promise.all([
      teamRef.get(),
      db.doc("config/relay").get(),
    ]);
    if (!teamSnap.exists) throw new ApiError(404, "no-team");
    const team = teamSnap.data() as Team;
    const cfg = cfgSnap.data() as Cfg | undefined;

    if (team.uid !== user.uid) throw new ApiError(403, "not-your-team");
    if (!cfg || cfg.status !== "running" || !cfg.startedAt) {
      throw new ApiError(409, "round-not-running");
    }
    const now = Date.now();
    const deadline =
      cfg.startedAt.toMillis() + cfg.durationMin * 60_000 + (team.bonusMs ?? 0);
    if (now > deadline + 3000) throw new ApiError(409, "time-up");
    if (team.status !== "active") throw new ApiError(409, "team-not-active");

    const qid = team.order[team.qIndex];
    const legStart = team.legStartedAt?.toMillis() ?? now;
    const inHandoff = legStart > now; // next member's turn has not begun yet

    // ---------- pass the baton ----------
    if (action === "pass") {
      const mode = body.mode;
      if (mode === "early") {
        if (now < legStart + cfg.minPassSec * 1000) throw new ApiError(409, "too-soon");
      } else if (mode === "timeout") {
        if (now < legStart + cfg.legSec * 1000 - 500) {
          return NextResponse.json({ ok: true, noop: true });
        }
      } else {
        throw new ApiError(400, "bad-request");
      }
      const changed = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.legStartedAt?.toMillis() !== team.legStartedAt?.toMillis()) return false;
        tx.update(teamRef, {
          holder: (cur.holder + 1) % Math.max(1, cur.memberNames.length),
          // the next member starts after the handoff countdown
          legStartedAt: Timestamp.fromMillis(now + HANDOFF_MS),
          bonusMs: (cur.bonusMs ?? 0) + HANDOFF_MS,
          judgingSince: null,
        });
        return true;
      });
      return NextResponse.json({ ok: true, noop: !changed });
    }

    // ---------- skip (forward only, no way back) ----------
    if (action === "skip") {
      if (inHandoff) throw new ApiError(409, "handoff");
      if (typeof body.qIndex !== "number" || body.qIndex !== team.qIndex) {
        throw new ApiError(409, "stale-submit");
      }
      const finished = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.qIndex !== team.qIndex || cur.status !== "active") {
          throw new ApiError(409, "stale-submit");
        }
        const done = cur.qIndex + 1 >= cur.order.length;
        tx.update(teamRef, {
          ...settleJudging(cur, now),
          skipped: (cur.skipped ?? 0) + 1,
          qIndex: cur.qIndex + 1,
          status: done ? "finished" : "active",
        });
        return done;
      });
      return NextResponse.json({ ok: true, finished });
    }

    // ---------- question / tests ----------
    if (!qid) throw new ApiError(409, "no-question");
    const bank = await getBank();
    const q = bank.find((x) => x.id === qid);
    if (!q) throw new ApiError(500, "question-missing");

    if (action === "question") {
      return NextResponse.json({
        question: {
          id: q.id,
          tier: q.tier,
          type: q.type,
          title: q.title,
          prompt: q.prompt,
          starterCode: q.starterCode,
          sampleInput: q.sampleInput,
          sampleOutput: q.sampleOutput,
        },
        index: team.qIndex,
        total: team.order.length,
      });
    }

    if (inHandoff) throw new ApiError(409, "handoff");
    if (!q.sampleOutput || !q.hiddenOutputs?.length) {
      throw new ApiError(500, "bank-not-ready");
    }
    const expected = [q.sampleOutput, ...q.hiddenOutputs];

    // pass/fail per test; expected outputs never leave the server
    const grade = (outputs: unknown): boolean[] => {
      if (
        !Array.isArray(outputs) ||
        outputs.length !== expected.length ||
        outputs.some((o) => typeof o !== "string" || o.length > 20000)
      ) {
        throw new ApiError(400, "bad-request");
      }
      return expected.map(
        (e, i) => normalizeOutput(outputs[i] as string) === normalizeOutput(e)
      );
    };

    // The browser asks for the test inputs, runs the code, sends the outputs back.
    // From here until check/finish arrives, the team's clock is paused.
    if (action === "start") {
      await teamRef.update({ judgingSince: Timestamp.fromMillis(now) });
      const token = signToken({
        teamId,
        qid,
        wrong: team.wrong,
        uid: user.uid,
        iat: now,
      } satisfies TokenPayload);
      return NextResponse.json({ token, inputs: [q.sampleInput, ...q.hiddenInputs] });
    }

    // Check tests: nothing scored, but the judging time is credited back
    if (action === "check") {
      const results = grade(body.outputs);
      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        tx.update(teamRef, settleJudging(cur, now));
      });
      return NextResponse.json({ results });
    }

    // Submit: the only action that is scored
    if (action === "finish") {
      const token = body.token;
      const p = typeof token === "string" ? verifyToken<TokenPayload>(token) : null;
      if (
        !p ||
        p.teamId !== teamId ||
        p.qid !== qid ||
        p.wrong !== team.wrong ||
        p.uid !== user.uid ||
        now - p.iat > 120_000
      ) {
        throw new ApiError(409, "stale-submit");
      }
      const ok = grade(body.outputs).every(Boolean);
      const finished = ok && team.qIndex + 1 >= team.order.length;

      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.qIndex !== team.qIndex || cur.wrong !== team.wrong || cur.status !== "active") {
          throw new ApiError(409, "stale-submit");
        }
        const settle = settleJudging(cur, now);
        if (ok) {
          tx.update(teamRef, {
            ...settle,
            solved: cur.solved + 1,
            solvedIds: FieldValue.arrayUnion(qid),
            qIndex: cur.qIndex + 1,
            lastSolveAt: Timestamp.fromMillis(now),
            status: finished ? "finished" : "active",
          });
        } else {
          tx.update(teamRef, { ...settle, wrong: cur.wrong + 1 });
        }
      });
      return NextResponse.json({ ok, finished });
    }

    throw new ApiError(400, "bad-request");
  } catch (e) {
    return errorResponse(e);
  }
}