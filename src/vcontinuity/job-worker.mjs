import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./data-root.mjs";

const id = process.argv[2];
if (!/^job_[0-9a-f]{12}$/.test(id || "")) process.exit(2);
const base = path.join(dataRoot, "jobs", id);
const stateFile = path.join(base, "state.json");
const cancelFile = path.join(base, "cancel.flag");
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const now = () => new Date().toISOString();

let state = JSON.parse(await fsp.readFile(stateFile, "utf8"));
if (state.status !== "queued" || state.jobId !== id) process.exit(3);
let saving = Promise.resolve();

function save() {
  const snapshot = JSON.stringify(state, null, 2);
  saving = saving.then(async () => {
    const temp = stateFile + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
    try {
      await fsp.writeFile(temp, snapshot, { flag: "wx" });
      await fsp.rename(temp, stateFile);
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
    }
  });
  return saving;
}

function event(type, text) {
  state.cursor++;
  state.events.push({ cursor: state.cursor, at: now(), type, text: String(text).slice(0, 500) });
  if (state.events.length > 200) state.events.shift();
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref();
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
}

state.supervisorPid = process.pid;
state.status = "running";
state.startedAt = now();
await save();

let child;
try {
  child = spawn(state.command[0], state.command.slice(1), {
    cwd: state.cwd,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
} catch (error) {
  state.status = "failed";
  state.reason = error.message;
  state.completedAt = now();
  event("error", error.message);
  await save();
  process.exit(1);
}

state.pid = child.pid || null;
state.executable = state.command[0];
delete state.command;
event("started", "Spawned process " + state.pid);
await save();

const outputs = [
  { stream: child.stdout, file: "stdout.log", used: 0, truncated: false },
  { stream: child.stderr, file: "stderr.log", used: 0, truncated: false },
];

for (const output of outputs) {
  const writer = fs.createWriteStream(path.join(base, output.file), { flags: "a" });
  output.stream.on("data", (chunk) => {
    if (output.used >= MAX_LOG_BYTES) {
      if (!output.truncated) {
        output.truncated = true;
        event("log_truncated", output.file);
      }
      return;
    }
    const bounded = chunk.subarray(0, Math.max(0, MAX_LOG_BYTES - output.used));
    output.used += bounded.length;
    if (bounded.length) writer.write(bounded);
  });
  output.writer = writer;
}

let reason = null;
let completed = false;
const timer = setTimeout(() => {
  if (completed) return;
  reason = "timed_out";
  event("timeout", "Exceeded " + state.timeoutMs + " ms");
  killTree(child);
}, state.timeoutMs);

const poll = setInterval(async () => {
  if (completed || reason) return;
  try {
    await fsp.access(cancelFile);
    reason = "cancelled";
    event("cancel_requested", "Cancellation received");
    killTree(child);
  } catch (error) {
    if (error.code !== "ENOENT") console.error("[vcontinuity-job] cancel-check:", error.message);
  }
}, 500);

const heartbeat = setInterval(() => {
  if (!completed) void save().catch((error) => console.error("[vcontinuity-job] state:", error.message));
}, 2000);

const done = await new Promise((resolve) => {
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };
  child.once("close", (code, signal) => finish({ code, signal }));
  child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
});

completed = true;
clearTimeout(timer);
clearInterval(poll);
clearInterval(heartbeat);
await Promise.all(outputs.map((output) => new Promise((resolve) => output.writer.end(resolve))));
state.status = reason || (done.error ? "failed" : done.code === 0 ? "completed" : "failed");
state.exitCode = done.code;
state.signal = done.signal;
state.completedAt = now();
if (done.error) state.reason = done.error;
event("completed", "Process ended: " + state.status + " code=" + done.code);
await save();
process.exit(0);
