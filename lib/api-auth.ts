import { NextResponse } from "next/server";
import type { DecodedIdToken } from "firebase-admin/auth";
import { adminAuth } from "./firebase-admin";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function requireStudent(req: Request): Promise<DecodedIdToken> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new ApiError(401, "no-token");
  let decoded: DecodedIdToken;
  try {
    decoded = await adminAuth().verifyIdToken(token);
  } catch {
    throw new ApiError(401, "bad-token");
  }
  if (decoded.role !== "student") throw new ApiError(403, "students-only");
  return decoded;
}

export function errorResponse(e: unknown) {
  if (e instanceof ApiError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error(e);
  return NextResponse.json({ error: "server-error" }, { status: 500 });
}