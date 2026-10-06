export interface RunResult {
  output: string;
  error: string | null;
  timedOut?: boolean;
}

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, (r: RunResult[]) => void>();

function boot() {
  const w = new Worker("/relay-worker.js");
  worker = w;
  ready = new Promise<void>((resolve) => {
    w.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === "ready" || d.type === "fatal") resolve();
      else if (d.type === "done") {
        pending.get(d.id)?.(d.results);
        pending.delete(d.id);
      }
    };
  });
}

// Start loading Python early so the first Run is quick.
export function warmUpPython() {
  if (!worker) boot();
}

export async function runPython(
  code: string,
  inputs: string[],
  timeoutMs = 8000
): Promise<RunResult[]> {
  if (!worker) boot();
  await ready;
  const w = worker!;
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      w.terminate();
      worker = null;
      ready = null;
      resolve(
        inputs.map(() => ({
          output: "",
          error: "Your program ran for too long. Check for a loop that never ends.",
          timedOut: true,
        }))
      );
      boot(); // restart in the background
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    w.postMessage({ id, code, inputs });
  });
}