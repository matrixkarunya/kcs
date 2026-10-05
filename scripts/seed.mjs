// Usage: node scripts/seed.mjs
// Needs serviceAccountKey.json in the project root (never commit it).
// Students come from scripts/students.csv (username,password,name).
// Safe to re-run: existing users are updated to match the CSV / admin values below.
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const ADMIN = {
  username: "admin-kcs-kits",
  password: "kcs-kits-matrix",
  name: "Admin",
};

const serviceAccount = JSON.parse(
  readFileSync(new URL("../serviceAccountKey.json", import.meta.url), "utf8")
);
initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

const toEmail = (u) => `${u.trim().toLowerCase()}@matrix-events.app`; // keep in sync with lib/auth-context.tsx

function readStudents() {
  const text = readFileSync(new URL("./students.csv", import.meta.url), "utf8");
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = header.split(",").map((c) => c.trim());
  const idx = (c) => cols.indexOf(c);
  if (idx("username") < 0 || idx("password") < 0) {
    throw new Error("students.csv needs username and password columns");
  }
  return lines.map((line) => {
    const p = line.split(",").map((c) => c.trim());
    const username = p[idx("username")];
    return {
      username,
      password: p[idx("password")],
      name: idx("name") >= 0 && p[idx("name")] ? p[idx("name")] : username,
    };
  });
}

async function upsertUser({ username, name, role, password }) {
  if (password.length < 6) throw new Error(`${username}: password must be 6+ characters`);
  const email = toEmail(username);
  let user;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password, displayName: name });
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    user = await auth.createUser({ email, password, displayName: name });
  }
  await auth.setCustomUserClaims(user.uid, { role });
  await db.doc(`users/${user.uid}`).set(
    {
      username: username.trim().toLowerCase(),
      name,
      role,
      teamId: null,
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

await upsertUser({ ...ADMIN, role: "admin" });
console.log(`admin ready: ${ADMIN.username}`);

const students = readStudents();
for (const s of students) {
  await upsertUser({ ...s, role: "student" });
  console.log(`seeded ${s.username}`);
}

console.log(`\nDone. 1 admin + ${students.length} students.`);
process.exit(0);