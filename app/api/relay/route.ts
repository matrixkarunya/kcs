import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { ApiError, errorResponse, requireStudent } from "@/lib/api-auth";
import { getBank, signToken, verifyToken } from "@/lib/relay-server";
import { normalizeOutput } from "@/lib/relay";

export const dynamic = "force-dynamic";

const HANDOFF_MS = 5000; // pause between one member and the next
const MAX_PAUSE_MS = 60_000; // longest single pause we will credit
const DEFAULT_CAP = 5; // questions per member

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
  bonusMs?: number; // time credited back (pauses + handoffs)
  judgingSince?: Timestamp | null; // a pause is running since this moment
  memberCounts?: number[]; // questions each member has used (solved or skipped)
  endedEarly?: boolean;
  status: "waiting" | "active" | "finished";
}
interface Cfg {
  status: string;
  startedAt: Timestamp | null;
  durationMin: number;
  legSec: number;
  minPassSec: number;
  maxPerMember?: number;
}
interface TokenPayload {
  teamId: string;
  qid: string;
  wrong: number;
  uid: string;
  iat: number;
}

// How much of the running pause counts (capped).
const pendingOf = (t: Team, now: number) => {
  const since = t.judgingSince?.toMillis();
  return since ? Math.max(0, Math.min(now - since, MAX_PAUSE_MS)) : 0;
};

// Folds a running pause into the permanent fields and clears it.
function settle(cur: Team, now: number): Record<string, unknown> {
  const pause = pendingOf(cur, now);
  const upd: Record<string, unknown> = { judgingSince: null };
  if (pause > 0) {
    upd.bonusMs = (cur.bonusMs ?? 0) + pause;
    if (cur.legStartedAt) {
      upd.legStartedAt = Timestamp.fromMillis(cur.legStartedAt.toMillis() + pause);
    }
  }
  return upd;
}

const countsOf = (t: Team) =>
  Array.from({ length: Math.max(1, t.memberNames.length) }, (_, i) => t.memberCounts?.[i] ?? 0);
const allFull = (cs: number[], cap: number) => cs.every((c) => c >= cap);

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
    const pending = pendingOf(team, now);
    const deadline =
      cfg.startedAt.toMillis() + cfg.durationMin * 60_000 + (team.bonusMs ?? 0) + pending;
    if (now > deadline + 3000) throw new ApiError(409, "time-up");
    if (team.status !== "active") throw new ApiError(409, "team-not-active");

    const cap = cfg.maxPerMember ?? DEFAULT_CAP;
    const counts = countsOf(team);
    const holderFull = (counts[team.holder] ?? 0) >= cap;

    const qid = team.order[team.qIndex];
    const legStart = (team.legStartedAt?.toMillis() ?? now) + pending;
    const inHandoff = legStart > now; // next member's turn has not begun yet

    // ---------- resume: the screen is showing, the clock may run again ----------
    if (action === "resume") {
      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (!cur.judgingSince) return;
        tx.update(teamRef, settle(cur, now));
      });
      return NextResponse.json({ ok: true });
    }

    // ---------- end the section for good ----------
    if (action === "end") {
      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.status !== "active") throw new ApiError(409, "team-not-active");
        tx.update(teamRef, { status: "finished", endedEarly: true, judgingSince: null });
      });
      return NextResponse.json({ ok: true });
    }

    // ---------- pass the baton ----------
    if (action === "pass") {
      const mode = body.mode;
      if (mode === "early") {
        if (inHandoff) throw new ApiError(409, "handoff");
        // a member who used all their questions may pass at once
        if (!holderFull && now < legStart + cfg.minPassSec * 1000) {
          throw new ApiError(409, "too-soon");
        }
      } else if (mode === "timeout") {
        if (now < legStart + cfg.legSec * 1000 - 500) {
          return NextResponse.json({ ok: true, noop: true });
        }
      } else {
        throw new ApiError(400, "bad-request");
      }

      const result = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.legStartedAt?.toMillis() !== team.legStartedAt?.toMillis()) return "stale";
        const cs = countsOf(cur);
        const n = cs.length;

        // next member who still has questions left
        let next = -1;
        for (let k = 1; k <= n; k++) {
          const i = (cur.holder + k) % n;
          if (cs[i] < cap) {
            next = i;
            break;
          }
        }
        if (next === -1) {
          tx.update(teamRef, { status: "finished", judgingSince: null });
          return "ok";
        }
        if (mode === "early" && next === cur.holder) throw new ApiError(409, "no-next");

        tx.update(teamRef, {
          holder: next,
          legStartedAt: Timestamp.fromMillis(now + HANDOFF_MS),
          bonusMs: (cur.bonusMs ?? 0) + pendingOf(cur, now) + HANDOFF_MS,
          judgingSince: null,
        });
        return "ok";
      });
      return NextResponse.json({ ok: true, noop: result === "stale" });
    }

    // ---------- skip (forward only, no way back) ----------
    if (action === "skip") {
      if (inHandoff) throw new ApiError(409, "handoff");
      if (holderFull) throw new ApiError(409, "member-done");
      if (typeof body.qIndex !== "number" || body.qIndex !== team.qIndex) {
        throw new ApiError(409, "stale-submit");
      }
      const finished = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.qIndex !== team.qIndex || cur.status !== "active") {
          throw new ApiError(409, "stale-submit");
        }
        const cs = countsOf(cur);
        if (cs[cur.holder] >= cap) throw new ApiError(409, "member-done");
        cs[cur.holder] += 1;
        const done = cur.qIndex + 1 >= cur.order.length || allFull(cs, cap);
        tx.update(teamRef, {
          // the clock stays paused until the client confirms the next screen
          judgingSince: done ? null : cur.judgingSince ?? Timestamp.fromMillis(now),
          memberCounts: cs,
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
    if (holderFull) throw new ApiError(409, "member-done");
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

    // Starts a pause. Any older pause is credited first, then a new one begins.
    if (action === "start") {
      await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        tx.update(teamRef, { ...settle(cur, now), judgingSince: Timestamp.fromMillis(now) });
      });
      const token = signToken({
        teamId,
        qid,
        wrong: team.wrong,
        uid: user.uid,
        iat: now,
      } satisfies TokenPayload);
      return NextResponse.json({ token, inputs: [q.sampleInput, ...q.hiddenInputs] });
    }

    // Check tests: nothing scored. The pause ends when the client sends "resume".
    if (action === "check") {
      return NextResponse.json({ results: grade(body.outputs) });
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

      const finished = await db.runTransaction(async (tx) => {
        const cur = (await tx.get(teamRef)).data() as Team;
        if (cur.qIndex !== team.qIndex || cur.wrong !== team.wrong || cur.status !== "active") {
          throw new ApiError(409, "stale-submit");
        }
        const pause = cur.judgingSince ?? Timestamp.fromMillis(now);
        if (!ok) {
          tx.update(teamRef, { wrong: cur.wrong + 1, judgingSince: pause });
          return false;
        }
        const cs = countsOf(cur);
        if (cs[cur.holder] >= cap) throw new ApiError(409, "member-done");
        cs[cur.holder] += 1;
        const done = cur.qIndex + 1 >= cur.order.length || allFull(cs, cap);
        tx.update(teamRef, {
          judgingSince: done ? null : pause, // stays paused until the next screen shows
          memberCounts: cs,
          solved: cur.solved + 1,
          solvedIds: FieldValue.arrayUnion(qid),
          qIndex: cur.qIndex + 1,
          lastSolveAt: Timestamp.fromMillis(now),
          status: done ? "finished" : "active",
        });
        return done;
      });
      return NextResponse.json({ ok, finished });
    }

    throw new ApiError(400, "bad-request");
  } catch (e) {
    return errorResponse(e);
  }
}