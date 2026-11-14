import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safePath } from "./filesystem.mjs";

const execute = promisify(execFile);
const MAX_FILES = 5000;
const MAX_BYTES = 64 * 1024 * 1024;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
};

// No shell, diffs, file contents, hooks or external Git filters are persisted/executed.
export async function captureWorkSnapshot(root, excludedRoots = []) {
  const capturedAt = new Date().toISOString();
  if (!root) return { status: "unavailable", reason: "no_project_root", capturedAt };
  let reason = "snapshot_failed";
  try {
    const cwd = await safePath(root, true, true);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
    env.GIT_OPTIONAL_LOCKS = "0";
    const git = async (...args) => (await execute("git", ["-C", cwd, ...args], {
      env, windowsHide: true, timeout: 3000, maxBuffer: 2 * 1024 * 1024,
    })).stdout;
    reason = "git_unavailable_or_not_repository";
    await git("rev-parse", "--show-toplevel");
    reason = "snapshot_failed";
    const head = async () => (await git("rev-parse", "--verify", "--quiet", "HEAD").catch((error) => {
      if (error.code === 1) return "unborn";
      throw error;
    })).trim();
    const headCommit = await head();
    const inventory = () => git("ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".");
    const listing = await inventory();
    const indexListing = await git("ls-files", "--stage", "-z", "--", ".");
    const index = new Map();
    for (const entry of indexListing.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const name = entry.slice(tab + 1);
      index.set(name, (index.get(name) || "") + entry.slice(0, tab));
    }
    const names = [...new Set(listing.split("\0").filter(Boolean))].sort();
    reason = "snapshot_limit";
    if (names.length > MAX_FILES) throw new Error(reason);
    const files = Object.create(null);
    let bytes = 0;
    const deadline = Date.now() + 5000;
    for (const name of names) {
      const target = path.resolve(cwd, name);
      if (excludedRoots.some((excluded) => inside(path.resolve(excluded), target))) continue;
      if (Date.now() > deadline) throw new Error("snapshot_limit");
      reason = "unsafe_or_unsupported_path";
      if (!inside(cwd, target)) throw new Error(reason);
      const stat = await fs.lstat(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) { files[name] = "deleted:" + (index.get(name) || ""); continue; }
      if (!stat.isFile() || !inside(cwd, await safePath(target, true))) throw new Error(reason);
      reason = "snapshot_limit";
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error(reason);
      reason = "snapshot_failed";
      const handle = await fs.open(target, "r");
      const hash = crypto.createHash("sha256");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let read = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer);
          if (!bytesRead) break;
          read += bytesRead;
          if (read > stat.size || Date.now() > deadline) { reason = "snapshot_changed_or_limit"; throw new Error(reason); }
          hash.update(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (read !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
          reason = "snapshot_changed_during_read"; throw new Error(reason);
        }
      } finally { await handle.close(); }
      files[name] = hash.update(String(stat.mode)).update(index.get(name) || "untracked").digest("hex");
    }
    reason = "snapshot_changed_during_read";
    if (listing !== await inventory() || headCommit !== await head()
      || indexListing !== await git("ls-files", "--stage", "-z", "--", ".")) throw new Error(reason);
    return { schema: 1, status: "captured", capturedAt, rootKey: digest(cwd), headCommit, files,
      fingerprint: digest(JSON.stringify([headCommit, files])) };
  } catch {
    return { status: "unavailable", reason, capturedAt };
  }
}

export function compareWorkSnapshot(baseline, current) {
  if (current.status !== "captured") return { status: "unavailable", reason: current.reason, changedFiles: [] };
  if (baseline?.status !== "captured" || baseline.schema !== current.schema || baseline.rootKey !== current.rootKey) {
    return { status: "unknown", reason: "baseline_missing", changedFiles: [] };
  }
  const changedFiles = baseline.files ? [...new Set([...Object.keys(baseline.files), ...Object.keys(current.files)])]
    .filter((name) => baseline.files[name] !== current.files[name]) : [];
  return { status: baseline.fingerprint === current.fingerprint ? "unchanged" : "changed",
    headChanged: baseline.headCommit !== current.headCommit,
    changedFiles: changedFiles.slice(0, 100), totalChangedFiles: changedFiles.length };
}
