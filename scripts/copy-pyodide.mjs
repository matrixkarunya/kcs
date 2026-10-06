import { cpSync, existsSync, mkdirSync, readdirSync } from "fs";

const src = new URL("../node_modules/pyodide/", import.meta.url);
const dest = new URL("../public/pyodide/", import.meta.url);

if (!existsSync(src)) {
  console.error("pyodide is not installed. Run: npm i pyodide");
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (/\.(d\.ts|d\.mts|map|md)$/.test(f)) continue;
  cpSync(new URL(f, src), new URL(f, dest), { recursive: true });
  n++;
}
console.log(`Copied ${n} files to public/pyodide`);