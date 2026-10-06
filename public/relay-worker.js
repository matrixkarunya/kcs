importScripts("/pyodide/pyodide.js");

// input() is replaced so a program reads exactly the lines we give it.
const HARNESS = [
  "import sys, builtins",
  "",
  "def __run(code, lines):",
  "    it = iter(lines)",
  "    def _input(prompt=''):",
  "        sys.stdout.write(str(prompt))",
  "        try:",
  "            return next(it)",
  "        except StopIteration:",
  "            raise EOFError('EOF when reading a line (the program asked for more input than was given)')",
  "    builtins.input = _input",
  "    g = {'__name__': '__main__'}",
  "    try:",
  "        exec(compile(code, 'main.py', 'exec'), g)",
  "    finally:",
  "        sys.stdout.flush()",
].join("\n");

const pyReady = (async () => {
  const py = await loadPyodide({ indexURL: "/pyodide/" });
  py.runPython(HARNESS);
  return py;
})();

pyReady
  .then(() => self.postMessage({ type: "ready" }))
  .catch((err) => self.postMessage({ type: "fatal", message: String(err) }));

function friendly(msg) {
  const lines = msg.trim().split("\n");
  const last = lines[lines.length - 1];
  const hits = [...msg.matchAll(/File "main\.py", line (\d+)/g)];
  const where = hits.length ? " (line " + hits[hits.length - 1][1] + ")" : "";
  return last + where;
}

function runOne(py, code, text) {
  let out = "";
  const dec = new TextDecoder();
  py.setStdout({
    write: (buf) => {
      if (out.length < 20000) out += dec.decode(buf, { stream: true });
      return buf.length;
    },
  });
  py.setStderr({ write: (buf) => buf.length });
  const lines = text === "" ? [] : text.split("\n");
  const pyLines = py.toPy(lines);
  let error = null;
  try {
    py.globals.get("__run")(code, pyLines);
  } catch (err) {
    error = friendly(String(err && err.message ? err.message : err));
  } finally {
    pyLines.destroy();
  }
  return { output: out, error };
}

self.onmessage = async (e) => {
  const { id, code, inputs } = e.data;
  try {
    const py = await pyReady;
    const results = inputs.map((text) => runOne(py, code, text));
    self.postMessage({ type: "done", id, results });
  } catch (err) {
    self.postMessage({
      type: "done",
      id,
      results: inputs.map(() => ({ output: "", error: "Python could not start." })),
    });
  }
};