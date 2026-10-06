import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { ApiError, errorResponse, requireStudent } from "@/lib/api-auth";
import { getBank, signToken, verifyToken } from "@/lib/relay-server";
import { normalizeOutput } from "@/lib/relay";

export const dynamic = "force-dynamic";

interface Team {
  uid: string;
  memberNames: string[];
  order: string[];
  qIndex: number;
  holder: number;
  legStartedAt: Timestamp | null;
  solved: number;
  wrong: number;
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
    if (now > cfg.startedAt.toMillis() + cfg.durationMin * 60_000 + 3000) {
      throw new ApiError(409, "time-up");
    }
    if (team.status !== "active") throw new ApiError(409, "team-not-active");

    const qid = team.order[team.qIndex];
    const legStart = team.legStartedAt?.toMillis() ?? now;

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
          legStartedAt: Timestamp.fromMillis(now),
        });
        return true;
      });
      return NextResponse.json({ ok: true, noop: !changed });
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

    // The browser asks for the test inputs, runs the code, sends the outputs back
    if (action === "start") {
      const token = signToken({
        teamId,
        qid,
        wrong: team.wrong,
        uid: user.uid,
        iat: now,
      } satisfies TokenPayload);
      return NextResponse.json({ token, inputs: [q.sampleInput, ...q.hiddenInputs] });
    }

    // Check tests: nothing is stored
    if (action === "check") {
      return NextResponse.json({ results: grade(body.outputs) });
    }

    // Submit: the only action that is stored
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
        if (ok) {
          tx.update(teamRef, {
            solved: cur.solved + 1,
            solvedIds: FieldValue.arrayUnion(qid),
            qIndex: cur.qIndex + 1,
            lastSolveAt: Timestamp.fromMillis(now),
            status: finished ? "finished" : "active",
          });
        } else {
          tx.update(teamRef, { wrong: cur.wrong + 1 });
        }
      });
      return NextResponse.json({ ok, finished });
    }

    throw new ApiError(400, "bad-request");
  } catch (e) {
    return errorResponse(e);
  }
}