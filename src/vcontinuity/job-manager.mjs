import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config, safePath } from "./filesystem.mjs";
import { dataRoot as stateRoot } from "./data-root.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(stateRoot, "jobs");
const archiveRoot = path.join(stateRoot, "jobs-archive");
const workerScript = path.join(here, "job-worker.mjs");
const MAX_ACTIVE = Math.max(1, Math.min(32, Number(config.maxConcurrent) || 8));
const MAX_RECORDS = 512;
const VALID_ID = /^job_[0-9a-f]{12}$/;
const VALID_ARCHIVE_ID = /^archive_[0-9a-f]{32}$/;
const PRUNE_PREVIEW_TTL_MS = 5 * 60 * 1000;
const DONE = new Set(["completed", "failed", "cancelled", "timed_out", "interrupted"]);
const prunePreviews = new WeakMap();
const now = () => new Date().toISOString();
const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jobDir(id) {
  if (!VALID_ID.test(id || "")) throw new Error("Invalid jobId");
  return path.join(dataRoot, id);
}

async function saveAtomically(file, value) {
  const temp = file + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function readJob(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(jobDir(id), "state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function listIds() {
  await fs.mkdir(dataRoot, { recursive: true });
  return (await fs.readdir(dataRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && VALID_ID.test(entry.name))
    .map((entry) => entry.name);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function viewState(state) {
  if (!state) return null;
  if (state.status === "running" && state.supervisorPid && !alive(state.supervisorPid)) {
    return { ...state, status: "interrupted", reason: "supervisor_process_not_running" };
  }
  if (state.status === "queued" && Date.now() - Date.parse(state.createdAt) > 15000 && !alive(state.supervisorPid)) {
    return { ...state, status: "interrupted", reason: "supervisor_did_not_start" };
  }
  return state;
}

async function tail(file, maxBytes) {
  try {
    const handle = await fs.open(file, "r");
    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, maxBytes);
      const bytes = Buffer.alloc(length);
      await handle.read(bytes, 0, length, stat.size - length);
      return bytes.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function details(id, afterCursor = 0) {
  const state = viewState(await readJob(id));
  if (!state) return { jobId: id, status: "not_found" };
  const dir = jobDir(id);
  const [stdout, stderr] = await Promise.all([
    tail(path.join(dir, "stdout.log"), 8000),
    tail(path.join(dir, "stderr.log"), 4000),
  ]);
  return {
    ...state,
    newEvents: (state.events || []).filter((event) => event.cursor > afterCursor),
    stdoutTail: stdout,
    stderrTail: stderr,
  };
}

// Admission must count and reserve slots in one operation in the unified runtime.
let startQueue = Promise.resolve();
function queueJobStart(input) {
  const start = startQueue.then(async () => {
    const command = input.command || (input.powershell
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", input.powershell]
      : null);
    if (!Array.isArray(command) || command.length < 1 || command.length > 128 || command.some((value) => typeof value !== "string" || value.length > 32768)) {
      throw new Error("Invalid job command");
    }
    const cwd = await safePath(input.cwd || config.defaultCwd, true, true);
    const ids = await listIds();
    if (ids.length >= MAX_RECORDS) throw new Error("Job history quota reached; archive old data/jobs entries");
    const states = await Promise.all(ids.map(readJob));
    if (states.filter((state) => state && ["queued", "running"].includes(viewState(state).status)).length >= MAX_ACTIVE) {
      throw new Error("Maximum active jobs reached");
    }
    const jobId = "job_" + crypto.randomBytes(6).toString("hex");
    const dir = jobDir(jobId);
    await fs.mkdir(dir, { recursive: false });
    const state = {
      jobId,
      title: String(input.title || command[0]).slice(0, 256),
      command,
      cwd,
      timeoutMs: Math.max(1000, Math.min(input.timeoutMs || 300000, 1800000)),
      status: "queued",
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      cursor: 0,
      events: [],
      pid: null,
      supervisorPid: null,
    };
    await saveAtomically(path.join(dir, "state.json"), state);
    try {
      const worker = spawn(process.execPath, [workerScript, jobId], {
        cwd,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, VCONTINUITY_DATA_ROOT: stateRoot },
        shell: false,
      });
      await new Promise((resolve, reject) => {
        worker.once("spawn", resolve);
        worker.once("error", reject);
      });
      worker.unref();
    } catch (error) {
      state.status = "failed";
      state.completedAt = now();
      state.reason = "supervisor_start_failed";
      await saveAtomically(path.join(dir, "state.json"), state);
      throw error;
    }
    return { ok: true, jobId, title: state.title, status: "queued", cursor: 0, persistent: true };
  });
  startQueue = start.catch(() => {});
  return start;
}

export async function manageJob(input = {}) {
  const action = input.action || "list";
  if (action === "start") return queueJobStart(input);

  if (action === "list") {
    const ids = await listIds();
    const jobs = (await Promise.all(ids.map(readJob))).filter(Boolean).map(viewState);
    jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return {
      ok: true,
      count: jobs.length,
      jobs: jobs.slice(0, 200).map((state) => ({
        jobId: state.jobId,
        title: state.title,
        status: state.status,
        pid: state.pid,
        supervisorPid: state.supervisorPid,
        createdAt: state.createdAt,
        completedAt: state.completedAt,
        exitCode: state.exitCode,
        cursor: state.cursor,
      })),
      truncated: jobs.length > 200,
    };
  }

  if (action === "read") {
    if (!VALID_ID.test(input.jobId || "")) throw new Error("Valid jobId required");
    const state = await details(input.jobId, Number(input.afterCursor || 0));
    if (state.status === "not_found") throw new Error("Job not found: " + input.jobId);
    return {
      ok: true,
      jobId: state.jobId,
      title: state.title,
      status: state.status,
      exitCode: state.exitCode,
      cursor: state.cursor,
      events: state.newEvents,
      stdout: state.stdoutTail,
      stderr: state.stderrTail,
      supervisorPid: state.supervisorPid,
      reason: state.reason || null,
    };
  }

  if (action === "wait") {
    const ids = Array.isArray(input.jobIds) ? input.jobIds : (input.jobId ? [input.jobId] : []);
    if (!ids.length || ids.length > 8 || ids.some((id) => !VALID_ID.test(id))) throw new Error("Valid jobId(s) required");
    const maxWait = Math.max(0, Math.min(Number(input.timeoutMs ?? 5000), 55000));
    const deadline = Date.now() + maxWait;
    let states;
    do {
      states = await Promise.all(ids.map((id) => details(id, Number(input.afterCursor || 0))));
      if (states.some((state) => !["running", "queued"].includes(state.status))) break;
      if (Date.now() >= deadline) break;
      await nap(Math.min(200, deadline - Date.now()));
    } while (true);
    return {
      ok: true,
      snapshots: states.map((state) => ({
        jobId: state.jobId,
        title: state.title,
        status: state.status,
        exitCode: state.exitCode,
        cursor: state.cursor,
        newEvents: state.newEvents,
        stdoutTail: state.stdoutTail,
        stderrTail: state.stderrTail,
        reason: state.reason || null,
      })),
    };
  }

  if (action === "cancel") {
    if (!VALID_ID.test(input.jobId || "")) throw new Error("Valid jobId required");
    const state = viewState(await readJob(input.jobId));
    if (!state) throw new Error("Job not found: " + input.jobId);
    if (DONE.has(state.status)) return { ok: true, jobId: state.jobId, status: state.status };
    await fs.writeFile(path.join(jobDir(input.jobId), "cancel.flag"), now(), { flag: "w" });
    return { ok: true, jobId: state.jobId, status: "cancellation_requested" };
  }

  throw new Error("Unsupported job action: " + action);
}

function cleanupError(reason) {
  return Object.assign(new Error(reason), { cleanupReason: reason });
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Refuse links (including Windows junctions) anywhere in the path, even when
// their target stays inside the state root. Only create verified directories.
async function checkedDir(dir, { create = false } = {}) {
  const parent = path.dirname(dir);
  if (parent !== dir) await checkedDir(parent, { create });
  if (create && parent !== dir) {
    await fs.mkdir(dir, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const stat = await fs.lstat(dir, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(dir), dir)) {
    throw cleanupError("unsafe_path");
  }
  return stat;
}

function definitelyStopped(pid) {
  if (pid === null) return true;
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

async function checkedTerminal(dir, id, { requireStopped = true } = {}) {
  const directory = await checkedDir(dir);
  let stateStat;
  for (const name of await fs.readdir(dir)) {
    const file = path.join(dir, name);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !samePath(await fs.realpath(file), file)) {
      throw cleanupError("unsafe_path");
    }
    if (name === "state.json") stateStat = stat;
  }
  if (!stateStat) throw cleanupError("not_verified_terminal");
  const file = path.join(dir, "state.json");
  const content = await fs.readFile(file, "utf8");
  const currentState = await fs.lstat(file, { bigint: true });
  if (fileVersion(stateStat) !== fileVersion(currentState) ||
      fileIdentity(directory) !== fileIdentity(await checkedDir(dir))) {
    throw cleanupError("generation_changed");
  }
  const state = JSON.parse(content);
  if (!state || state.jobId !== id || !DONE.has(state.status) ||
      typeof state.completedAt !== "string" || !Number.isFinite(Date.parse(state.completedAt)) ||
      (requireStopped && (!definitelyStopped(state.supervisorPid) || !definitelyStopped(state.pid)))) {
    throw cleanupError("not_verified_terminal");
  }
  const directoryId = fileIdentity(directory);
  const generation = `${directoryId}:${fileVersion(stateStat)}:${crypto.createHash("sha256").update(content).digest("hex")}`;
  return { state, generation, directoryId };
}

const fileIdentity = (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const fileVersion = (stat) => `${fileIdentity(stat)}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;

async function withJobMove(jobId, move) {
  await checkedDir(archiveRoot, { create: true });
  const lock = path.join(archiveRoot, `${jobId}.lock`);
  let handle;
  try { handle = await fs.open(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw cleanupError("locked_or_denied"); throw error; }
  try { return await move(); }
  finally {
    // Only release the marker acquired by this call. After a crash, fail
    // closed rather than guessing whether another process still owns it.
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}

function failure(jobId, error) {
  const reason = error.cleanupReason || (error.code === "ENOENT" ? "not_found" :
    ["EBUSY", "EPERM", "EACCES"].includes(error.code) ? "locked_or_denied" : "filesystem_error");
  return { jobId, reason };
}

export async function previewJobPrune() {
  const items = [];
  const generations = new Map();
  const candidates = Object.freeze(Object.create(null));
  try { await checkedDir(dataRoot); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const ids = await fs.readdir(dataRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const jobId of ids.filter((id) => VALID_ID.test(id)).sort()) {
    try {
      const { state: { title, status, completedAt }, generation } = await checkedTerminal(jobDir(jobId), jobId);
      const label = typeof title === "string" && title ? title : jobId;
      items.push({ label, jobId, status, completedAt });
      generations.set(jobId, generation);
    } catch { /* Unreadable, unsafe and still active records are not candidates. */ }
  }
  prunePreviews.set(candidates, { generations, expiresAt: Date.now() + PRUNE_PREVIEW_TTL_MS });
  return { items, count: items.length, candidates };
}

export async function pruneJobs({ jobIds, candidates } = {}) {
  if (!Array.isArray(jobIds) || jobIds.length > MAX_RECORDS) throw new Error("Invalid jobIds");
  const preview = prunePreviews.get(candidates);
  if (preview) prunePreviews.delete(candidates);
  const archiveId = "archive_" + crypto.randomBytes(16).toString("hex");
  const batch = path.join(archiveRoot, archiveId);
  const failed = [];
  let archived = 0;
  let batchCreated = false;
  let renamed = false;
  for (const jobId of new Set(jobIds)) {
    if (typeof jobId !== "string" || !VALID_ID.test(jobId)) {
      failed.push({ jobId: typeof jobId === "string" ? jobId : null, reason: "invalid_job_id" });
      continue;
    }
    try {
      const generation = preview?.generations.get(jobId);
      if (!generation || preview.expiresAt <= Date.now()) throw cleanupError("not_reviewed");
      await withJobMove(jobId, async () => {
        const source = jobDir(jobId);
        if (!batchCreated) {
          await fs.mkdir(batch, { mode: 0o700 });
          batchCreated = true;
        }
        await checkedDir(batch);
        const current = await checkedTerminal(source, jobId);
        if (current.generation !== generation) throw cleanupError("generation_changed");
        const destination = path.join(batch, jobId);
        await fs.rename(source, destination);
        renamed = true;
        // Windows can report success for competing renames of the same source.
        // Count the move only if this batch actually holds the reviewed folder.
        if (fileIdentity(await checkedDir(destination)) !== current.directoryId) throw cleanupError("generation_changed");
        archived++;
      });
    } catch (error) { failed.push(failure(jobId, error)); }
  }
  return { ok: !failed.length, archived, failed, ...(renamed ? { archiveId } : {}) };
}

async function requireAbsent(file) {
  try { await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw cleanupError("destination_exists");
}

export async function restoreJobs(archiveId) {
  if (typeof archiveId !== "string" || !VALID_ARCHIVE_ID.test(archiveId)) throw new Error("Invalid archiveId");
  const batch = path.join(archiveRoot, archiveId);
  const failed = [];
  let restored = 0;
  try {
    await checkedDir(batch);
    await checkedDir(dataRoot, { create: true });
    for (const jobId of (await fs.readdir(batch)).sort()) {
      if (!VALID_ID.test(jobId)) {
        failed.push({ jobId, reason: "invalid_job_id" });
        continue;
      }
      try {
        await withJobMove(jobId, async () => {
          const source = path.join(batch, jobId);
          const destination = jobDir(jobId);
          const { directoryId } = await checkedTerminal(source, jobId, { requireStopped: false });
          await requireAbsent(destination);
          await fs.rename(source, destination);
          if (fileIdentity(await checkedDir(destination)) !== directoryId) throw cleanupError("generation_changed");
          restored++;
        });
      } catch (error) { failed.push(failure(jobId, error)); }
    }
  } catch (error) { failed.push(failure(null, error)); }
  return { ok: !failed.length, restored, failed };
}
