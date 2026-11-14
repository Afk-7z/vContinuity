import { spawn } from "node:child_process";
import path from "node:path";
import crypto from "node:crypto";
import { config, safePath, toMarkdownLink } from "./filesystem.mjs";

let active = 0;
const waiting = [];

async function withConcurrencySlot(fn) {
  const max = Math.max(1, Number(config.maxConcurrent) || 32);
  if (active >= max) await new Promise((resolve) => waiting.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

export function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    try { child.kill(); } catch {}
  }
}

export async function runCommand(input) {
  const command = input.command || (input.powershell
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", input.powershell]
    : null);
  if (!Array.isArray(command) || command.length < 1 || command.length > 128 || command.some((value) => typeof value !== "string" || value.length > 32768)) {
    throw new Error("command must be an argv array or powershell script");
  }
  const cwd = await safePath(input.cwd || config.defaultCwd, true, true);
  const timeoutMs = Math.max(100, Math.min(input.timeoutMs || 30000, 120000));
  const maxChars = Math.max(1000, Math.min(input.maxChars || config.maxOutputChars, 300000));

  return withConcurrencySlot(async () => {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let done = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      child.stdout.on("data", (buffer) => {
        const next = stdout + buffer.toString("utf8");
        stdoutTruncated ||= next.length > maxChars;
        stdout = next.slice(0, maxChars);
      });
      child.stderr.on("data", (buffer) => {
        const next = stderr + buffer.toString("utf8");
        stderrTruncated ||= next.length > maxChars;
        stderr = next.slice(0, maxChars);
      });
      child.once("error", (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          id: input.id ?? undefined,
          ok: exitCode === 0 && !timedOut,
          command,
          cwd,
          exitCode,
          signal,
          timedOut,
          durationMs: Date.now() - started,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
        });
      });
    });
  });
}

export async function runCommands(commands, mode = "sequential") {
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) throw new Error("commands supports 1-20 entries");
  if (!["sequential", "parallel", "allSettled"].includes(mode)) throw new Error("Invalid execution mode");
  if (mode === "parallel" || mode === "allSettled") {
    const settled = await Promise.allSettled(commands.map((entry) => runCommand(entry)));
    const results = settled.map((item, index) => item.status === "fulfilled"
      ? item.value
      : { id: commands[index].id, ok: false, error: item.reason?.message || String(item.reason) });
    return { ok: results.every((item) => item.ok), mode, count: results.length, results };
  }
  const results = [];
  for (const entry of commands) {
    try {
      results.push(await runCommand(entry));
    } catch (error) {
      results.push({ id: entry.id, ok: false, error: error.message });
    }
    if (!results.at(-1)?.ok) break;
  }
  return { ok: results.every((item) => item.ok), mode, count: results.length, results };
}

export async function searchFiles(query, cwd, limit = 80, filesOnly = false) {
  const base = await safePath(cwd || config.defaultCwd, true, true);
  if (filesOnly) {
    const args = ["rg", "--files", "--color", "never", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**"];
    if (query?.trim()) args.push("-g", "*" + query.trim() + "*");
    const result = await runCommand({ command: args, cwd: base, timeoutMs: 15000, maxChars: 180000 });
    if (![0, 1].includes(result.exitCode)) throw new Error(result.stderr || "rg --files failed");
    const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, limit).map((relative) => {
      const absolutePath = path.resolve(base, relative);
      return { path: relative, absolutePath, markdownLink: toMarkdownLink(absolutePath, 1, relative) };
    });
    return { ok: true, cwd: base, query: query || "*", mode: "files", files, truncated: result.stdoutTruncated };
  }

  if (typeof query !== "string" || !query.trim() || query.length > 4000) throw new Error("Invalid query");
  const result = await runCommand({
    command: ["rg", "-n", "--no-heading", "--color", "never", "--glob", "!**/node_modules/**", "--glob", "!**/.git/**", "--max-count", "10", "--", query, "."],
    cwd: base,
    timeoutMs: 15000,
    maxChars: 180000,
  });
  if (![0, 1].includes(result.exitCode)) throw new Error(result.stderr || "rg failed");
  const raw = result.stdout.split(/\r?\n/).filter(Boolean);
  const matches = raw.slice(0, limit).map((line) => {
    const match = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!match) return { raw: line };
    const relative = match[1].replace(/^\.[\\/]/, "");
    const lineNumber = Number(match[2]);
    const absolutePath = path.resolve(base, relative);
    return {
      file: relative,
      absolutePath,
      line: lineNumber,
      text: match[3],
      markdownLink: toMarkdownLink(absolutePath, lineNumber, path.basename(relative) + ":" + lineNumber),
    };
  });
  return { ok: true, cwd: base, query, matches, truncated: result.stdoutTruncated || raw.length > limit };
}

export async function gitOperation(input = {}) {
  const action = input.action || "status";
  const cwd = await safePath(input.cwd || config.defaultCwd, true, true);

  if (action === "status") {
    return runCommand({ command: ["git", "status", "--short", "--branch", "--untracked-files=normal"], cwd, timeoutMs: 20000 });
  }
  if (action === "diff") {
    return runCommand({ command: input.staged ? ["git", "diff", "--cached"] : ["git", "diff"], cwd, timeoutMs: 20000, maxChars: 180000 });
  }
  if (action === "log") {
    const limit = Math.max(1, Math.min(Number(input.limit || 20), 100));
    return runCommand({ command: ["git", "log", "--oneline", "--decorate", "-n", String(limit)], cwd, timeoutMs: 20000, maxChars: 120000 });
  }
  if (action === "branch_list") {
    return runCommand({ command: ["git", "branch", "--all", "--no-color"], cwd, timeoutMs: 15000 });
  }
  if (action === "branch_create") {
    const branch = String(input.branch || "").trim();
    if (!branch) throw new Error("branch is required");
    return runCommand({ command: ["git", "checkout", "-b", branch], cwd, timeoutMs: 20000 });
  }
  if (action === "branch_delete") {
    const branch = String(input.branch || "").trim();
    if (!branch) throw new Error("branch is required");
    return runCommand({ command: ["git", "branch", input.force ? "-D" : "-d", branch], cwd, timeoutMs: 20000 });
  }
  if (action === "worktree_list") {
    return runCommand({ command: ["git", "worktree", "list", "--porcelain"], cwd, timeoutMs: 15000 });
  }
  if (action === "worktree_create") {
    const branch = String(input.branch || ("work-" + crypto.randomBytes(3).toString("hex"))).trim();
    const target = input.targetPath
      ? await safePath(input.targetPath, false, false)
      : path.join(path.dirname(cwd), path.basename(cwd) + "-wt-" + branch.replace(/[^a-zA-Z0-9._-]/g, "-"));
    const result = await runCommand({ command: ["git", "worktree", "add", "-b", branch, target], cwd, timeoutMs: 30000 });
    return { ...result, branch, worktreePath: target };
  }
  if (action === "worktree_remove") {
    if (!input.targetPath) throw new Error("targetPath is required");
    const target = await safePath(input.targetPath, false, false);
    const args = ["git", "worktree", "remove", target];
    if (input.force) args.push("--force");
    const result = await runCommand({ command: args, cwd, timeoutMs: 20000 });
    return { ...result, worktreePath: target };
  }
  throw new Error("Unsupported git action: " + action);
}
