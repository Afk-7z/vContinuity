import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { dataRoot } from "./data-root.mjs";
import { safePath } from "./filesystem.mjs";

const DEFAULT_ROOT = path.join(dataRoot, "works");
const WORK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const REVIEW_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const JOURNAL_READ_BYTES = 512 * 1024;
const SURFACES = new Set(["agent", "web"]);
const locks = new Map();

function now() { return new Date().toISOString(); }
function cleanText(value, max = 20000) {
  if (value == null) return "";
  const text = String(value).replace(/\r\n/g, "\n");
  return text.length > max ? text.slice(0, max) : text;
}
function cleanList(value, maxItems = 100, maxChars = 2000) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => cleanText(item, maxChars)).filter(Boolean);
}
function requireWorkId(workId) {
  const id = String(workId ?? "").trim();
  if (!WORK_ID_RE.test(id) || id.endsWith(".") || RESERVED_NAME.test(id)) {
    throw new Error("Invalid workId: use letters, numbers, dot, underscore, or hyphen");
  }
  return id;
}
function requireSurface(surface) {
  const value = cleanText(surface, 16).trim().toLowerCase();
  if (!SURFACES.has(value)) throw new Error("Invalid work surface");
  return value;
}
function jsonLine(value) { return JSON.stringify(value) + "\n"; }
function checkpointName(sequence) { return String(sequence).padStart(4, "0") + ".md"; }
function compactionName(sequence) { return String(sequence).padStart(4, "0") + ".md"; }
function redactSensitive(value, max = 20000) {
  const text = String(value ?? "")
    .replace(/\bBearer[ \t]+[A-Za-z0-9._~+\/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)["']?[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s"'&;,]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_\w{12,}|cw_(?:at|rt|code)_[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[REDACTED]");
  return cleanText(text, max);
}
function redactPreview(value) { return redactSensitive(value, 600); }
function compactList(value, maxItems = 100, maxChars = 2000) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => redactSensitive(item, maxChars)).filter(Boolean);
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function atomicWrite(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(5).toString("hex");
  try {
    await fs.writeFile(temp, data, { encoding: "utf8", flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
function jsonDocument(value) { return JSON.stringify(value, null, 2) + "\n"; }
async function atomicJson(file, value) { await atomicWrite(file, jsonDocument(value)); }
async function readJson(file, optional = false) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; throw error; }
}
async function readText(file, optional = false) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (optional && error?.code === "ENOENT") return null; throw error; }
}
const PENDING_REVISION = ".pending-revision.json";
const revisionFile = /^(?:work\.json|state\.json|context\.md|handoff\.md|compact\.md|(?:checkpoints|compactions)\/(?:latest|\d{4,})\.md)$/;
const revisionLog = /^(?:events|decisions)\.jsonl$/;

async function recoverRevision(dir) {
  const pending = path.join(dir, PENDING_REVISION);
  const undo = await readJson(pending, true);
  if (!undo) return;
  if (!Array.isArray(undo) || !undo.every(({ name, before, size }) =>
    (revisionFile.test(name) && (before === null || typeof before === "string")) ||
    (revisionLog.test(name) && (size === null || Number.isSafeInteger(size) && size >= 0)))) {
    throw new Error("Invalid Work Context recovery journal");
  }
  for (const { name, before, size } of undo) {
    const file = path.join(dir, name);
    if (size === null || before === null) {
      await fs.rm(file, { force: true });
    } else if (size !== undefined) {
      const stat = await fs.stat(file);
      if (stat.size < size) throw new Error("Work Context history shrank during recovery");
      if (stat.size > size) await fs.truncate(file, size);
    } else if (await readText(file, true) !== before) {
      await atomicWrite(file, before);
    }
  }
  await fs.unlink(pending);
}

async function commitRevision(dir, files, appends) {
  const undo = [];
  for (const [name] of files) {
    undo.push({ name, before: await readText(path.join(dir, name), true) });
  }
  for (const [name] of appends) {
    const stat = await fs.stat(path.join(dir, name)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && !stat.isFile()) throw new Error("Invalid journal file: " + name);
    undo.push({ name, size: stat?.size ?? null });
  }
  // Keep the undo record until all files and journal entries have been written.
  await atomicJson(path.join(dir, PENDING_REVISION), undo);
  try {
    for (const [name, data] of files) await atomicWrite(path.join(dir, name), data);
    for (const [name, data] of appends) await fs.appendFile(path.join(dir, name), data, "utf8");
    await fs.unlink(path.join(dir, PENDING_REVISION));
  } catch (error) {
    try { await recoverRevision(dir); }
    catch (recoveryError) {
      throw new AggregateError([error, recoveryError], "Work Context write failed; recovery is pending");
    }
    throw error;
  }
}
async function tailJsonl(file, limit = 50) {
  let handle;
  let raw;
  try {
    handle = await fs.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - JOURNAL_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    raw = buffer.toString("utf8", 0, bytesRead);
    if (start) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
    }
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close();
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const output = [];
  for (const line of lines.slice(-Math.max(1, Math.min(limit, 200)))) {
    try { output.push(JSON.parse(line)); } catch {}
  }
  return output;
}
function markdownSection(title, items) {
  const list = cleanList(items);
  return "## " + title + "\n" + (list.length ? list.map((x) => "- " + x).join("\n") : "- None recorded") + "\n\n";
}
function checkpointMarkdown({ work, state, sequence, summary, completed, decisions, nextSteps, unresolved, filesChanged, tests, revalidate, client, surface }) {
  let md = "# Work Checkpoint " + String(sequence).padStart(4, "0") + "\n\n";
  md += "Work: " + work.workId + "\nRevision: " + work.revision + "\nClient: " + client + " (" + surface + ")\nUpdated: " + work.updatedAt + "\n\n";
  md += "## Goal\n" + (work.goal || work.title || work.workId) + "\n\n";
  md += "## Current State\n" + (summary || state.currentTask || "No semantic summary recorded.") + "\n\n";
  md += markdownSection("Completed", completed) + markdownSection("Decisions", decisions) + markdownSection("Files Changed", filesChanged);
  md += markdownSection("Tests / Verification", tests) + markdownSection("Unresolved", unresolved) + markdownSection("Next Actions", nextSteps);
  md += markdownSection("Revalidate", revalidate);
  return md;
}
function contextMarkdown({ work, state, summary, completed, decisions, nextSteps, unresolved, filesChanged, tests, revalidate }) {
  let md = "# Work Context: " + work.workId + "\n\n";
  md += "Revision: " + work.revision + "\nStatus: " + work.status + "\nProject root: " + (work.root || "(not set)") + "\nLast client: " + (work.lastClient || "(unknown)") + "\nUpdated: " + work.updatedAt + "\n\n";
  md += "## Goal\n" + (work.goal || work.title || work.workId) + "\n\n";
  md += "## Current State\n" + (summary || state.currentTask || "No semantic summary recorded.") + "\n\n";
  md += markdownSection("Completed", completed) + markdownSection("Decisions", decisions) + markdownSection("Files Changed", filesChanged);
  md += markdownSection("Tests / Verification", tests) + markdownSection("Unresolved", unresolved) + markdownSection("Next Actions", nextSteps);
  md += markdownSection("Revalidate", revalidate);
  md += "## Continuation Rule\nContinue from this state. Do not redo completed work unless new evidence requires it. Verify mutable external state before acting.\n";
  return md;
}
function handoffMarkdown({ work, state, summary, completed, decisions, nextSteps, unresolved, filesChanged, tests, revalidate, fromClient, toClient }) {
  let md = "# WORK HANDOFF\n\n";
  md += "WORK_ID: " + work.workId + "\nREVISION: " + work.revision + "\nFROM: " + (fromClient || work.lastClient || "unknown") + "\nTO: " + (toClient || "next client") + "\nPROJECT_ROOT: " + (work.root || "(not set)") + "\nUPDATED: " + work.updatedAt + "\n\n";
  md += "## GOAL\n" + (work.goal || work.title || work.workId) + "\n\n## CURRENT STATE\n" + (summary || state.currentTask || "No semantic summary recorded.") + "\n\n";
  md += markdownSection("COMPLETED", completed) + markdownSection("DECISIONS", decisions) + markdownSection("FILES CHANGED", filesChanged);
  md += markdownSection("COMMANDS / TESTS", tests) + markdownSection("KNOWN FAILURES / OPEN QUESTIONS", unresolved) + markdownSection("NEXT ACTION", nextSteps);
  md += markdownSection("REVALIDATE", revalidate);
  md += "## DO NOT REDO\nUse the completed items and event journal as evidence. Re-run only what must be revalidated because state may have changed.\n";
  return md;
}
function compactionMarkdown({ work, state, sequence, at, latestSteering, currentState, completed, decisions, filesChanged, tests, failures, doNotRedo, revalidate, outstanding, nextSteps, openQuestions, client, surface }) {
  let md = "# WORK COMPACTION " + String(sequence).padStart(4, "0") + "\n\n";
  md += "WORK_ID: " + work.workId + "\nREVISION: " + work.revision + "\nCLIENT: " + client + " (" + surface + ")\nUPDATED: " + at + "\n\n";
  md += "## ORIGINAL_GOAL\n" + (work.goal || work.title || work.workId) + "\n\n";
  md += "## LATEST_STEERING\n" + (latestSteering || "No later steering recorded.") + "\n\n";
  md += "## CURRENT_STATE\n" + (currentState || state.currentTask || "No semantic summary recorded.") + "\n\n";
  md += markdownSection("COMPLETED", completed);
  md += markdownSection("DECISIONS", decisions);
  md += markdownSection("FILES_AND_COMPONENTS", filesChanged);
  md += markdownSection("VALIDATION", tests);
  md += markdownSection("FAILURES", failures);
  md += markdownSection("DO_NOT_REDO", doNotRedo);
  md += markdownSection("REVALIDATE", revalidate);
  md += markdownSection("OUTSTANDING", outstanding);
  md += markdownSection("NEXT_ACTION", nextSteps);
  md += markdownSection("OPEN_QUESTIONS", openQuestions);
  md += "## CONTINUATION_RULE\nCompaction does not end the task. Continue this work as one logical chain. Do not redo completed work unless new evidence requires it. Revalidate mutable runtime state before depending on it. Use journals and project files when exact evidence is needed.\n";
  return md;
}
function summarizeArgs(tool, args = {}) {
  const out = {};
  for (const key of ["cwd", "path", "action", "title", "branch", "targetPath"]) {
    if (typeof args[key] === "string" && args[key]) out[key] = redactSensitive(args[key], 1000);
  }
  if (Array.isArray(args.paths)) out.paths = args.paths.slice(0, 20).map((x) => redactSensitive(x, 1000));
  if (Array.isArray(args.command)) {
    out.executable = redactPreview(args.command[0]);
    out.argumentCount = Math.max(0, args.command.length - 1);
  }
  if (typeof args.powershell === "string") out.powershell = true;
  if (Array.isArray(args.commands)) out.batchCount = args.commands.length;
  if (typeof args.mode === "string") out.mode = args.mode;
  if (tool === "vcontinuity.fs_write" && typeof args.content === "string") out.contentBytes = Buffer.byteLength(args.content, "utf8");
  if (tool === "vcontinuity.fs_patch") {
    out.expectedOccurrences = args.expectedOccurrences ?? 1;
    out.replacementBytes = typeof args.replacementText === "string" ? Buffer.byteLength(args.replacementText, "utf8") : 0;
  }
  return out;
}
function summarizeResult(result = {}) {
  const value = result && typeof result.structuredContent === "object" && result.structuredContent
    ? result.structuredContent
    : result;
  const out = {};
  for (const key of ["ok", "exitCode", "changed", "sha256", "count", "status", "threadId", "branch", "mode"]) {
    if (value && value[key] !== undefined) {
      out[key] = typeof value[key] === "string" ? redactPreview(value[key]) : value[key];
    }
  }
  if (value && Array.isArray(value.results)) out.resultCount = value.results.length;
  if (value && Array.isArray(value.matches)) out.matchCount = value.matches.length;
  if (value && Array.isArray(value.entries)) out.entryCount = value.entries.length;
  if (result && typeof result.isError === "boolean") out.isError = result.isError;
  return out;
}

const NOTE_HEADINGS = {
  completed: ["Completed"],
  decisions: ["Decisions"],
  filesChanged: ["Files Changed", "FILES_AND_COMPONENTS"],
  tests: ["Tests / Verification", "COMMANDS / TESTS", "VALIDATION"],
  unresolved: ["Unresolved", "KNOWN FAILURES / OPEN QUESTIONS", "OUTSTANDING"],
  nextSteps: ["Next Actions", "NEXT_ACTION", "NEXT ACTION"],
  revalidate: ["Revalidate"],
};

function section(markdown, headings) {
  const lines = (markdown || "").split(/\r?\n/);
  const start = lines.findIndex((line) =>
    headings.some((heading) => line.toLowerCase() === ("## " + heading).toLowerCase()));
  if (start === -1) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ") && line !== "- None recorded") items.push(line.slice(2));
  }
  return compactList(items);
}

function notesFromState(state, context) {
  return Object.fromEntries(Object.entries(NOTE_HEADINGS).map(([name, headings]) => [
    name,
    state.notes?.[name] ?? (name === "nextSteps" ? state.nextActions
      : name === "unresolved" ? state.blockedBy : section(context, headings)) ?? [],
  ]));
}

function readSnapshotMeta(markdown, source) {
  const header = markdown.split(/\r?\n\r?\n## /, 1)[0];
  const revision = Number(/^revision:\s*(\d+)\r?$/im.exec(header)?.[1]);
  const at = Date.parse(/^updated:[ \t]*(.+)$/im.exec(header)?.[1]);
  return { markdown, source, revision, at };
}

function chooseSnapshot(work, { context, handoff, compact }) {
  return [
    compact && readSnapshotMeta(compact, "compact"),
    handoff && readSnapshotMeta(handoff, "handoff"),
    context && readSnapshotMeta(context, "context"),
  ].filter((entry) => entry && Number.isSafeInteger(entry.revision) && entry.revision <= work.revision && Number.isFinite(entry.at))
    .sort((a, b) => b.revision - a.revision || b.at - a.at)[0] || null;
}

async function readWorkSnapshots(dir, work) {
  const [context, compact, handoff] = await Promise.all(["context.md", "compact.md", "handoff.md"]
    .map((name) => readText(path.join(dir, name), true)));
  return { context, compact, handoff, latest: chooseSnapshot(work, { context, compact, handoff }) };
}

function snapshotState(state, { context, latest }) {
  if (latest?.source !== "compact" || (state.revision === latest.revision
      && state.compactionRevision === latest.revision && state.notes && Date.parse(state.lastCompactionAt) === latest.at)) {
    return { currentState: state.currentTask, notes: notesFromState(state, context) };
  }
  const currentState = latest.markdown.split(/^## CURRENT_STATE\r?\n/im)[1]?.split(/\r?\n## /, 1)[0]?.trim();
  const notes = Object.fromEntries(Object.entries(NOTE_HEADINGS).map(([name, headings]) => [
    name, section(latest.markdown, headings),
  ]));
  return { currentState: currentState || state.currentTask, notes };
}

function materialEvent(event) {
  if (event.type !== "tool_call") return false;
  if (event.tool === "vcontinuity.fs_patch") return event.result?.changed === true;
  if (event.tool === "vcontinuity.fs_write") return event.ok;
  if (event.tool === "vcontinuity.exec") return true;
  if (event.tool === "vcontinuity.job") return ["start", "cancel"].includes(event.args?.action);
  if (event.tool === "vcontinuity.git") return ["branch_create", "branch_delete", "worktree_create", "worktree_remove"].includes(event.args?.action);
  return event.tool === "vcontinuity.transfer" && ["import", "export"].includes(event.args?.action);
}

function eventsAfterSnapshot(events, snapshot) {
  if (!snapshot) return events.filter(materialEvent);
  const anchors = {
    context: ["work_created", "context_update", "checkpoint", "handoff", "work_closed"],
    handoff: ["handoff"],
    compact: ["compaction"],
  };
  const anchor = events.findLastIndex((event) => anchors[snapshot.source].includes(event.type)
    && event.revision === snapshot.revision && Date.parse(event.at) <= snapshot.at);
  if (anchor >= 0) return events.slice(anchor + 1).filter(materialEvent);
  return events.filter((event) => materialEvent(event)
    && (event.revision > snapshot.revision || Date.parse(event.at) > snapshot.at));
}

function continuationText(snapshot, context, recentChanges) {
  const base = snapshot?.markdown ?? context;
  if (!recentChanges.length) return base;
  const lines = recentChanges.map(({ at, tool, args, ok }) =>
    "- " + at + " · " + tool + (args?.action ? " (" + args.action + ")" : "") + (ok ? "" : " · failed"));
  return (base || "") + "\n\n## Recent activity after this summary\n" + lines.join("\n")
    + "\n\nConsult recentEvents for details and checkpoint any verified progress.\n";
}

function workGuidance(work, state, { recentChanges, latestActivity }) {
  const lastUpdatedAt = Date.parse(state?.lastCompactionAt) > Date.parse(work.updatedAt)
    ? state.lastCompactionAt : work.updatedAt;
  const ageMs = Date.now() - Date.parse(lastUpdatedAt);
  const activityAfterSummary = latestActivity?.revision >= work.revision && Date.parse(latestActivity.at) >= Date.parse(lastUpdatedAt);
  const reason = recentChanges.length || activityAfterSummary ? "recent_activity" : ageMs >= REVIEW_AGE_MS ? "review_age" : null;
  const status = work.status === "closed" ? "closed" : reason ? "checkpoint_recommended" : "ready";
  return {
    status, reason: status === "checkpoint_recommended" ? reason : null, lastUpdatedAt,
    action: { closed: null, checkpoint_recommended: "checkpoint", ready: "resume" }[status],
  };
}

export function workBinding(extra) {
  const connection = extra?.http?.authInfo?.connectionId;
  const session = extra?.sessionId || extra?.mcpReq?._meta?.["vcontinuity/session"];
  const validSession = typeof session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session);
  const owner = typeof connection === "string" && connection ? "oauth:" + connection : null;
  return validSession ? (owner || "local") + "/mcp:" + session : owner;
}

function projectId(root) {
  const basename = path.basename(root) || "project";
  const slug = basename.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return !slug || RESERVED_NAME.test(slug) ? "project-" + (slug || "local") : slug;
}

function conflict(expectedRevision, currentRevision) {
  return Object.assign(new Error("WORK_REVISION_CONFLICT:expected=" + expectedRevision + ":current=" + currentRevision), {
    code: "WORK_REVISION_CONFLICT", currentRevision,
  });
}

function scopeOf(root, target) {
  const relative = path.relative(root, target);
  if (relative === "") return 0;
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) return -1;
  return relative.split(path.sep).length;
}

async function projectBoundary(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try {
      const marker = await fs.lstat(path.join(dir, ".git"));
      if (marker.isDirectory() || marker.isFile()) return dir;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    try { await safePath(parent, true, true); } catch { return null; }
  }
}

export class WorkContextService {
  constructor({ root = DEFAULT_ROOT } = {}) { this.root = path.resolve(root); }
  workDir(workId) { return path.join(this.root, requireWorkId(workId)); }
  activeFile(surface, binding) {
    const name = ".active-" + requireSurface(surface);
    const suffix = binding ? "-" + crypto.createHash("sha256").update(binding).digest("hex") : "";
    return path.join(this.root, name + suffix + ".json");
  }
  async ensureRoot() { await fs.mkdir(this.root, { recursive: true }); }
  async withLock(workId, fn) {
    const dir = this.workDir(workId);
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const next = previous.then(() => gate);
    locks.set(key, next);
    await previous;
    try {
      await recoverRevision(dir);
      return await fn();
    }
    finally { release(); if (locks.get(key) === next) locks.delete(key); }
  }
  async load(workId) {
    const id = requireWorkId(workId), dir = this.workDir(id);
    return { id, dir, work: await readJson(path.join(dir, "work.json")), state: await readJson(path.join(dir, "state.json")) };
  }
  async setActive(surface, workId, client, binding = null) {
    await this.ensureRoot();
    const id = requireWorkId(workId);
    await atomicJson(this.activeFile(surface, binding), { workId: id, client: redactSensitive(client || surface, 128), surface: requireSurface(surface), at: now() });
  }
  async activateAfterCommit(surface, workId, client, binding) {
    await this.setActive(surface, workId, client, binding).catch((error) => {
      console.error("[vcontinuity] Work Context saved, but activation failed:", error.code || error.message);
    });
  }
  async getActive(surface, binding = null) {
    const pointer = await readJson(this.activeFile(surface, binding), true);
    if (!pointer?.workId) return null;
    try {
      const { work } = await this.withLock(pointer.workId, () => this.load(pointer.workId));
      return work.status === "closed" ? null : { ...pointer, workId: work.workId, revision: work.revision, status: work.status };
    }
    catch { return null; }
  }
  async create({ workId, title, goal, root, client, surface = "agent", binding = null, activate = true }) {
    await this.ensureRoot();
    const id = requireWorkId(workId), dir = this.workDir(id);
    return this.withLock(id, async () => {
      if (await exists(path.join(dir, "work.json"))) throw new Error("WORK_ALREADY_EXISTS:" + id);
      const at = now(), actor = redactSensitive(client || surface, 128);
      const work = { schema: 1, workId: id, title: redactSensitive(title || id, 300), goal: redactSensitive(goal || "", 12000), root: root ? path.resolve(String(root)) : null, status: "active", revision: 1, createdAt: at, updatedAt: at, lastClient: actor };
      const state = { schema: 1, workId: id, revision: 1, phase: "active", currentTask: work.goal || work.title, blockedBy: [], nextActions: [], lastCheckpoint: 0, lastCheckpointAt: null, lastCompaction: 0, lastCompactionAt: null, lastClient: actor };
      await fs.mkdir(path.join(dir, "checkpoints"), { recursive: true }); await fs.mkdir(path.join(dir, "compactions"), { recursive: true }); await fs.mkdir(path.join(dir, "artifacts"), { recursive: true });
      await atomicJson(path.join(dir, "work.json"), work); await atomicJson(path.join(dir, "state.json"), state);
      await atomicWrite(path.join(dir, "context.md"), contextMarkdown({ work, state, summary: state.currentTask, completed: [], decisions: [], nextSteps: [], unresolved: [], filesChanged: [], tests: [] }));
      for (const file of ["events.jsonl", "commands.jsonl", "files.jsonl", "decisions.jsonl"]) await atomicWrite(path.join(dir, file), "");
      await fs.appendFile(path.join(dir, "events.jsonl"), jsonLine({ at, type: "work_created", surface, client: actor, revision: 1 }), "utf8");
      if (activate) await this.setActive(surface, id, actor, binding);
      return { ok: true, created: true, work, state, contextPath: path.join(dir, "context.md") };
    });
  }
  async scan() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !WORK_ID_RE.test(entry.name)) continue;
      if (entry.name.endsWith(".") || RESERVED_NAME.test(entry.name)) continue;
      const work = await this.withLock(entry.name, () => readJson(path.join(this.root, entry.name, "work.json"), true));
      if (work) items.push(work);
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items;
  }
  async list({ limit = 50, root } = {}) {
    if (root) {
      const continuity = await this.discover(root);
      return { ok: true, root: this.root, count: continuity.works.length, works: continuity.works.slice(0, limit), continuity };
    }
    const items = await this.scan();
    return { ok: true, root: this.root, count: items.length, works: items.slice(0, Math.max(1, Math.min(limit, 200))) };
  }
  async discover(cwd) {
    const real = await safePath(cwd, true, true);
    const boundary = await projectBoundary(real);
    const items = await this.scan();
    const nearby = items.map((work) => ({
      work,
      distance: typeof work.root === "string" && work.root
        && (!boundary || scopeOf(boundary, work.root) >= 0) ? scopeOf(work.root, real) : -1,
    })).filter(({ distance }) => distance >= 0);
    const distance = Math.min(...nearby.map((match) => match.distance));
    const works = await Promise.all(nearby.filter((match) => match.distance === distance)
      .slice(0, 50).map(async ({ work }) => {
        const details = await this.inspect(work.workId, { historyLimit: 40 });
        return { ...details.work, guidance: details.guidance };
      }));
    const best = works.find((work) => work.status !== "closed") ?? works[0];
    const projectRoot = best?.root ?? boundary ?? real;
    const slug = projectId(projectRoot);
    const ids = new Set(items.map((work) => work.workId.toLowerCase()));
    const suffix = crypto.createHash("sha256").update(process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot).digest("hex").slice(0, 8);
    let suggestedWorkId = slug;
    for (let sequence = 0; ids.has(suggestedWorkId); sequence++) {
      suggestedWorkId = slug + "-" + suffix + (sequence ? "-" + sequence : "");
    }
    return {
      ...best?.guidance,
      status: best?.guidance.status ?? "unregistered",
      reason: best?.guidance.reason ?? (best ? null : "no_matching_work"),
      action: best?.guidance.action ?? (best ? null : "create"),
      root: projectRoot,
      works,
      suggestedWorkId,
      suggestedTitle: path.basename(projectRoot) || slug,
    };
  }
  async status({ workId, surface, binding }) {
    if (!workId) return { ok: true, active: surface ? await this.getActive(surface, binding) : null };
    const { work, state, guidance } = await this.inspect(workId, { historyLimit: 40 });
    return { ok: true, work, state, guidance, active: surface ? await this.getActive(surface, binding) : null };
  }
  async guidanceFor(work, state, recentChanges = []) {
    const latestActivity = await readJson(path.join(this.workDir(work.workId), "activity.json"), true).catch(() => null);
    return workGuidance(work, state, { recentChanges, latestActivity });
  }
  async inspect(workId, { historyLimit = 30, includeHistory = false } = {}) {
    return this.withLock(workId, async () => {
      const { dir, work, state } = await this.load(workId);
      const paths = { work: path.join(dir, "work.json"), state: path.join(dir, "state.json"), context: path.join(dir, "context.md"), compact: path.join(dir, "compact.md"), handoff: path.join(dir, "handoff.md") };
      const [snapshots, events] = await Promise.all([
        readWorkSnapshots(dir, work),
        tailJsonl(path.join(dir, "events.jsonl"), 200),
      ]);
      const { context, compact, handoff, latest } = snapshots;
      const recentChanges = eventsAfterSnapshot(events, latest).slice(-10);
      const { currentState, notes } = snapshotState(state, snapshots);
      const detail = {
        ok: true, work, state, context, compact, handoff, paths,
        continuationContext: continuationText(latest, context, recentChanges),
        continuationSource: latest?.source ?? (context ? "context" : null),
        continuationRevision: latest?.revision ?? null,
        recentEvents: events.slice(-Math.max(1, Math.min(historyLimit, 200))),
        recentChanges,
        summary: { currentState, nextSteps: notes.nextSteps, tests: notes.tests, revalidate: notes.revalidate, unresolved: notes.unresolved },
        guidance: await this.guidanceFor(work, state, recentChanges),
      };
      if (includeHistory) {
        detail.history = await this.readHistory(dir, detail.recentEvents, historyLimit);
        detail.checkpoints = await this.listCheckpoints(dir);
      }
      return detail;
    });
  }
  async resume({ workId, surface = "web", client, historyLimit = 30, binding = null, activate = true }) {
    const detail = await this.inspect(workId, { historyLimit });
    const actor = redactSensitive(client || surface, 128);
    if (activate) await this.withLock(workId, async () => {
      const { dir, work } = await this.load(workId);
      if (work.status === "closed") return;
      await this.setActive(surface, work.workId, actor, binding);
      await fs.appendFile(path.join(dir, "events.jsonl"), jsonLine({
        at: now(), type: "work_resumed", surface: requireSurface(surface), client: actor, revision: work.revision,
      }), "utf8");
    });
    return detail;
  }
  async listCheckpoints(dir) {
    const entries = await fs.readdir(path.join(dir, "checkpoints"), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return entries.filter((entry) => entry.isFile() && /^\d{4,}\.md$/.test(entry.name))
      .map((entry) => ({ sequence: Number(entry.name.slice(0, -3)) }))
      .sort((a, b) => b.sequence - a.sequence).slice(0, 100);
  }
  async readCheckpoint(workId, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid checkpoint number");
    return this.withLock(workId, async () => {
      const { dir } = await this.load(workId);
      const content = await readText(path.join(dir, "checkpoints", checkpointName(sequence)));
      return { ok: true, sequence, content };
    });
  }
  async readHistory(dir, events, limit) {
    const [commands, files, decisions] = await Promise.all([
      tailJsonl(path.join(dir, "commands.jsonl"), limit),
      tailJsonl(path.join(dir, "files.jsonl"), limit),
      tailJsonl(path.join(dir, "decisions.jsonl"), limit),
    ]);
    return { events, commands, files, decisions };
  }
  async history({ workId, limit = 50 }) {
    return this.withLock(workId, async () => {
      const { dir, work } = await this.load(workId);
      const events = await tailJsonl(path.join(dir, "events.jsonl"), limit);
      return { ok: true, workId: work.workId, revision: work.revision, ...await this.readHistory(dir, events, limit) };
    });
  }
  async semanticUpdate(args, { checkpoint = false, handoff = false, close = false } = {}) {
    const id = requireWorkId(args.workId), surface = requireSurface(args.surface || "agent");
    const actor = redactSensitive(args.client || surface, 128);
    return this.withLock(id, async () => {
      const { dir, work, state } = await this.load(id);
      if (Number.isInteger(args.expectedRevision) && args.expectedRevision !== work.revision) {
        throw conflict(args.expectedRevision, work.revision);
      }
      const previous = snapshotState(state, await readWorkSnapshots(dir, work));
      const revision = work.revision + 1, at = now(), summary = redactSensitive(args.summary ?? previous.currentState, 20000);
      const notes = Object.fromEntries(Object.keys(NOTE_HEADINGS).map((name) => [
        name, compactList(args[name] ?? previous.notes[name]),
      ]));
      if (typeof args.goal === "string") work.goal = redactSensitive(args.goal, 12000);
      if (typeof args.title === "string") work.title = redactSensitive(args.title, 300);
      if (typeof args.root === "string" && args.root.trim()) work.root = path.resolve(args.root);
      work.revision = revision; work.updatedAt = at; work.lastClient = actor; if (close) work.status = "closed";
      state.revision = revision; state.phase = close ? "closed" : redactSensitive(args.phase || state.phase || "active", 100);
      state.currentTask = summary; state.blockedBy = notes.unresolved; state.nextActions = notes.nextSteps; state.lastClient = actor; state.notes = notes;
      let sequence = state.lastCheckpoint || 0;
      if (checkpoint) { sequence += 1; state.lastCheckpoint = sequence; state.lastCheckpointAt = at; }
      const files = [["context.md", contextMarkdown({ work, state, summary, ...notes })]];
      if (checkpoint) {
        const md = checkpointMarkdown({ work, state, sequence, summary, ...notes, client: actor, surface });
        files.push(["checkpoints/" + checkpointName(sequence), md], ["checkpoints/latest.md", md]);
      }
      if (handoff) {
        const md = handoffMarkdown({ work, state, summary, ...notes, fromClient: actor, toClient: redactSensitive(args.toClient, 128) });
        files.push(["handoff.md", md]);
      }
      files.push(["state.json", jsonDocument(state)], ["work.json", jsonDocument(work)]);
      const decisions = compactList(args.decisions).map((decision) => jsonLine({ at, revision, client: actor, surface, decision })).join("");
      const event = jsonLine({ at, type: close ? "work_closed" : handoff ? "handoff" : checkpoint ? "checkpoint" : "context_update", surface, client: actor, revision, checkpoint: checkpoint ? sequence : undefined });
      await commitRevision(dir, files, decisions ? [["decisions.jsonl", decisions], ["events.jsonl", event]] : [["events.jsonl", event]]);
      if (!close && args.activate !== false) await this.activateAfterCommit(surface, id, actor, args.binding);
      return { ok: true, work, state, checkpoint: checkpoint ? sequence : null, contextPath: path.join(dir, "context.md"), handoffPath: handoff ? path.join(dir, "handoff.md") : null };
    });
  }
  async compact(args) {
    const id = requireWorkId(args.workId), surface = requireSurface(args.surface || "agent"), actor = redactSensitive(args.client || surface, 128);
    return this.withLock(id, async () => {
      const { dir, work, state } = await this.load(id);
      if (Number.isInteger(args.expectedRevision) && args.expectedRevision !== work.revision) {
        throw conflict(args.expectedRevision, work.revision);
      }
      const at = now(), sequence = (state.lastCompaction || 0) + 1;
      const previous = snapshotState(state, await readWorkSnapshots(dir, work));
      const { notes } = previous;
      const currentState = redactSensitive(args.currentState ?? args.summary ?? previous.currentState, 20000);
      const compactedNotes = Object.fromEntries(Object.keys(NOTE_HEADINGS).map((name) => [
        name, compactList((name === "unresolved" ? args.outstanding ?? args.unresolved : args[name]) ?? notes[name]),
      ]));
      work.revision += 1;
      work.updatedAt = at;
      work.lastClient = actor;
      Object.assign(state, {
        revision: work.revision, currentTask: currentState, notes: compactedNotes,
        nextActions: compactedNotes.nextSteps, blockedBy: compactedNotes.unresolved,
        lastCompaction: sequence, lastCompactionAt: at, lastClient: actor,
        compactionRevision: work.revision,
      });
      const md = compactionMarkdown({
        work,
        state,
        sequence,
        at,
        latestSteering: redactSensitive(args.latestSteering || "", 12000),
        currentState,
        ...compactedNotes,
        failures: compactList(args.failures),
        doNotRedo: compactList(args.doNotRedo),
        outstanding: compactedNotes.unresolved,
        openQuestions: compactList(args.openQuestions),
        client: actor,
        surface
      });
      await commitRevision(dir, [
        ["compact.md", md], ["compactions/" + compactionName(sequence), md], ["compactions/latest.md", md],
        ["state.json", jsonDocument(state)], ["work.json", jsonDocument(work)],
      ], [["events.jsonl", jsonLine({ at, type: "compaction", surface, client: actor, revision: work.revision, compaction: sequence })]]);
      if (work.status !== "closed" && args.activate !== false) await this.activateAfterCommit(surface, id, actor, args.binding);
      return { ok: true, work, state, compaction: sequence, compact: md, continuationContext: md, compactPath: path.join(dir, "compact.md"), historyPath: path.join(dir, "compactions", compactionName(sequence)) };
    });
  }
  async recordToolEvent({ surface = "web", binding, workId, tool, args = {}, result = null, error = null }) {
    const s = requireSurface(surface);
    const target = workId === undefined ? (await this.getActive(s, binding))?.workId : workId;
    if (!target) return { recorded: false, reason: "no_active_work" };
    const id = requireWorkId(target);
    return this.withLock(id, async () => {
      const { dir, work } = await this.load(id); if (work.status === "closed") return { recorded: false, reason: "work_closed" };
      const event = { at: now(), type: "tool_call", surface: s, workId: id, revision: work.revision, tool: cleanText(tool, 200), ok: !error && result?.ok !== false, args: summarizeArgs(tool, args), result: error ? { error: redactSensitive(error instanceof Error ? error.message : error, 1000) } : summarizeResult(result) };
      await fs.appendFile(path.join(dir, "events.jsonl"), jsonLine(event), "utf8");
      if (materialEvent(event)) {
        await atomicJson(path.join(dir, "activity.json"), { at: event.at, revision: work.revision });
      }
      if (/\b(exec|job|batch_exec|thread_manage)\b/.test(tool)) await fs.appendFile(path.join(dir, "commands.jsonl"), jsonLine(event), "utf8");
      if (/\b(write_file|edit_exact|fs_write|fs_patch)\b/.test(tool)) await fs.appendFile(path.join(dir, "files.jsonl"), jsonLine(event), "utf8");
      return { recorded: true, workId: id, revision: work.revision };
    });
  }
}

export const workContextService = new WorkContextService();
export async function workContextOp(args, { surface = "web", binding = null, activate = true } = {}) {
  const action = cleanText(args.action || "status", 40), base = { ...args, surface, binding, activate }, service = workContextService;
  if (action === "create") return service.create(base);
  if (action === "list") return service.list(base);
  if (action === "status") return service.status(base);
  if (action === "open" || action === "resume") return service.resume(base);
  if (action === "history") return service.history(base);
  if (action === "compact") return service.compact(base);
  if (action === "checkpoint") return service.semanticUpdate(base, { checkpoint: true });
  if (action === "update") return service.semanticUpdate(base);
  if (action === "handoff") return service.semanticUpdate(base, { checkpoint: true, handoff: true });
  if (action === "close") return service.semanticUpdate(base, { checkpoint: true, close: true });
  throw new Error("Unsupported work context action: " + action);
}
