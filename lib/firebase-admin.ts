import { cert, getApps, initializeApp, App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import path from "path";

function getAdminApp(): App {
  if (getApps().length) return getApps()[0];
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT ??
    readFileSync(path.join(process.cwd(), "serviceAccountKey.json"), "utf8");
  return initializeApp({ credential: cert(JSON.parse(raw)) });
}

export const adminAuth = () => getAuth(getAdminApp());
export const adminDb = () => getFirestore(getAdminApp());