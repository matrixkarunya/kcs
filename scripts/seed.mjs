// Usage:
//   node scripts/seed.mjs              -> seeds scripts/users.csv
//   node scripts/seed.mjs other.csv    -> seeds scripts/other.csv
// Needs serviceAccountKey.json in the project root (never commit it).
// CSV columns: username,password,name
// The admin is NOT seeded here (already created).
// Safe to re-run: existing users get their password/name/role updated, but
// teamId and createdAt are only set when the user is first created, so
// existing team assignments are never wiped.
import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";

const CSV_FILE = process.argv[2] ?? "users.csv";

const serviceAccount = JSON.parse(
  readFileSync(new URL("../serviceAccountKey.json", import.meta.url), "utf8")
);
initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

const toEmail = (u) => `${u.trim().toLowerCase()}@matrix-events.app`; // keep in sync with lib/auth-context.tsx

function readStudents() {
  const text = readFileSync(new URL(`./${CSV_FILE}`, import.meta.url), "utf8");
  const [header, ...lines] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = header.split(",").map((c) => c.trim());
  const idx = (c) => cols.indexOf(c);
  if (idx("username") < 0 || idx("password") < 0) {
    throw new Error(`${CSV_FILE} needs username and password columns`);
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
  let created = false;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password, displayName: name });
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
    user = await auth.createUser({ email, password, displayName: name });
    created = true;
  }
  await auth.setCustomUserClaims(user.uid, { role });

  const data = {
    username: username.trim().toLowerCase(),
    name,
    role,
  };
  if (created) {
    data.teamId = null;
    data.createdAt = FieldValue.serverTimestamp();
  }
  await db.doc(`users/${user.uid}`).set(data, { merge: true });
  return created;
}

const students = readStudents();
let createdCount = 0;
for (const s of students) {
  const created = await upsertUser({ ...s, role: "student" });
  if (created) createdCount++;
  console.log(`${created ? "created" : "updated"} ${s.username}`);
}

console.log(
  `\nDone. ${students.length} students from ${CSV_FILE} (${createdCount} new, ${students.length - createdCount} updated).`
);
process.exit(0);