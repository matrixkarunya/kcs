import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyB6aTGqUVmCZ3fQg1_vhCN2BJOR8x8MOx4",
  authDomain: "kcs-kits.firebaseapp.com",
  projectId: "kcs-kits",
  storageBucket: "kcs-kits.firebasestorage.app",
  messagingSenderId: "1049374445958",
  appId: "1:1049374445958:web:106b31a24b3681d06f5c07"
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;