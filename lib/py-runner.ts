export interface PyResult {
  output: string;
  error: string | null;
}

// Bump the number after ?v= whenever you change relay-worker.js.
// It forces the browser to drop any cached (old classic) worker.
const WORKER_URL = "/relay-worker.js?v=3";

let worker: Worker | null = null;
let workerReady: Promise<Worker> | null = null;
let nextId = 1;
// Runs are serialized: one Python job at a time on the single worker.
let chain: Promise<unknown> = Promise.resolve();

function resetWorker(w?: Worker) {
  if (w && w !== worker) return;
  worker?.terminate();
  worker = null;
  workerReady = null;
}

function getWorker(): Promise<Worker> {
  if (workerReady) return workerReady;

  const w = new Worker(WORKER_URL, { type: "module" });
  worker = w;

  workerReady = new Promise<Worker>((resolve, reject) => {
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (d?.type === "ready") {
        cleanup();
        resolve(w);
      } else if (d?.type === "fatal") {
        cleanup();
        resetWorker(w);
        reject(new Error(d.message || "Pyodide failed to load"));
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      resetWorker(w);
      reject(new Error(e.message || "Worker failed to start (check /pyodide/pyodide.mjs loads)"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
  });

  return workerReady;
}

function allFail(inputs: string[], error: string): PyResult[] {
  return inputs.map(() => ({ output: "", error }));
}

async function runOnce(code: string, inputs: string[], timeoutMs: number): Promise<PyResult[]> {
  let w: Worker;
  try {
    // Loading Pyodide is not counted against the time limit.
    w = await getWorker();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return allFail(inputs, `Python could not start: ${m}`);
  }

  return new Promise<PyResult[]>((resolve) => {
    const id = nextId++;

    const finish = (results: PyResult[]) => {
      clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      resolve(results);
    };

    const onMessage = (e: MessageEvent) => {
      const d = e.data;
      if (d?.type === "done" && d.id === id) finish(d.results as PyResult[]);
    };

    const onError = (e: ErrorEvent) => {
      resetWorker(w);
      finish(allFail(inputs, `Python worker crashed: ${e.message || "unknown error"}`));
    };

    // Python runs synchronously inside the worker, so the only way to stop an
    // infinite loop is to kill the worker. A fresh one is created on the next run.
    const timer = setTimeout(() => {
      resetWorker(w);
      finish(allFail(inputs, "Time limit exceeded"));
    }, timeoutMs);

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.postMessage({ id, code, inputs });
  });
}

/**
 * Runs `code` once per entry in `inputs` (each entry is the full stdin text).
 * Returns one { output, error } per input, in order.
 * `timeoutMs` applies to the whole call, excluding Pyodide startup.
 */
export function runPython(
  code: string,
  inputs: string[],
  timeoutMs = 10000
): Promise<PyResult[]> {
  const job = chain.then(() => runOnce(code, inputs, timeoutMs));
  chain = job.catch(() => undefined);
  return job;
}