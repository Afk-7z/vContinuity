import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { VCONTINUITY_VERSION } from "./version.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const configPath = process.env.VCONTINUITY_CONFIG
  ? path.resolve(process.env.VCONTINUITY_CONFIG)
  : path.join(projectRoot, "vcontinuity.config.json");
const homeDir = os.homedir();

const defaults = {
  workspaceRoots: [
    projectRoot,
    path.join(homeDir, "Documents"),
    path.join(homeDir, "Projects"),
    path.join(homeDir, "Downloads"),
    path.join(homeDir, "Desktop"),
  ],
  defaultCwd: projectRoot,
  maxOutputChars: 150000,
  maxReadChars: 400000,
  maxConcurrent: 32,
};

export const config = Object.assign(
  {},
  defaults,
  JSON.parse(await fs.readFile(configPath, "utf8").catch(() => "{}")),
);

const roots = await Promise.all(
  config.workspaceRoots.map(async (value) => {
    const literal = path.resolve(value);
    return { literal, real: await fs.realpath(literal).catch(() => literal) };
  }),
);

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

async function canonical(target) {
  let cursor = target;
  while (true) {
    try {
      return path.join(await fs.realpath(cursor), path.relative(cursor, target));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
}

export async function safePath(raw = config.defaultCwd, mustExist = false, directory = false) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 32768) throw new Error("Invalid path");
  const target = path.resolve(path.isAbsolute(raw) ? raw : path.join(config.defaultCwd, raw));
  if (!roots.some((root) => inside(root.literal, target))) throw new Error("Outside workspace roots: " + target);
  const real = await canonical(target);
  if (!roots.some((root) => inside(root.real, real))) throw new Error("Symlink or junction escapes workspace roots");
  if (mustExist) {
    const stat = await fs.stat(real);
    if (directory && !stat.isDirectory()) throw new Error("Expected directory");
  }
  return real;
}

export function toMarkdownLink(absPath, line = null, label = null) {
  const normalized = String(absPath).replace(/\\/g, "/");
  const name = label || path.basename(absPath);
  const target = line ? normalized + ":" + line : normalized;
  return target.includes(" ") ? `[${name}](<${target}>)` : `[${name}](${target})`;
}

async function readInstruction(file, scope) {
  try {
    return {
      path: file,
      markdownLink: toMarkdownLink(file, 1, "AGENTS.md"),
      scope,
      content: (await fs.readFile(file, "utf8")).slice(0, 30000),
    };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function projectContext(cwd) {
  const dir = await safePath(cwd || config.defaultCwd, true, true);
  const instructions = [];
  const seen = new Set();

  const global = await readInstruction(path.join(homeDir, "AGENTS.md"), "global");
  if (global) {
    instructions.push(global);
    seen.add(path.resolve(global.path).toLowerCase());
  }

  const local = [];
  let current = dir;
  while (roots.some((root) => inside(root.literal, current))) {
    const file = path.join(current, "AGENTS.md");
    const key = path.resolve(file).toLowerCase();
    if (!seen.has(key)) {
      const item = await readInstruction(file, "project");
      if (item) {
        local.unshift(item);
        seen.add(key);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  instructions.push(...local);

  return {
    ok: true,
    name: "vContinuity",
    version: VCONTINUITY_VERSION,
    cwd: dir,
    workspaceRoots: roots.map((root) => root.literal),
    instructions,
    capabilities: {
      filesystem: true,
      commands: true,
      jobs: true,
      git: true,
      transfer: true,
      workContext: true,
      computerUse: false,
      externalAgentRuntime: false,
    },
  };
}

export async function listTree(dir, depth = 2, limit = 250) {
  const base = await safePath(dir || config.defaultCwd, true, true);
  const entries = [];
  const hidden = new Set(["node_modules", ".git", ".next", "dist", "build", "__pycache__"]);
  const maxDepth = Math.max(0, Math.min(depth, 5));
  const maxEntries = Math.max(1, Math.min(limit, 600));

  async function walk(current, level) {
    const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of children) {
      if (entries.length >= maxEntries) return;
      const full = path.join(current, item.name);
      entries.push({
        path: path.relative(base, full),
        absolutePath: full,
        markdownLink: toMarkdownLink(full),
        type: item.isSymbolicLink() ? "link" : item.isDirectory() ? "directory" : "file",
      });
      if (item.isDirectory() && !hidden.has(item.name) && level < maxDepth) await walk(full, level + 1);
    }
  }

  await walk(base, 0);
  return { ok: true, root: base, entries, truncated: entries.length >= maxEntries };
}

export async function readFiles(paths, maxChars = config.maxReadChars) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100) throw new Error("Provide 1-100 paths");
  const max = Math.max(1000, Math.min(maxChars, 1000000));
  const results = await Promise.all(paths.map(async (raw) => {
    try {
      const target = await safePath(raw, true);
      const bytes = await fs.readFile(target);
      if (bytes.includes(0)) throw new Error("Binary file");
      const content = bytes.toString("utf8");
      return {
        path: target,
        markdownLink: toMarkdownLink(target, 1),
        content: content.slice(0, max),
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        truncated: content.length > max,
      };
    } catch (error) {
      return { path: raw, error: error.message };
    }
  }));
  return { ok: true, results };
}

export async function patchExact(input) {
  const target = await safePath(input.path, true);
  const expected = String(input.expectedText || "");
  if (!expected) throw new Error("expectedText required");
  const raw = await fs.readFile(target);
  if (raw.includes(0)) throw new Error("Binary file");
  const oldHash = crypto.createHash("sha256").update(raw).digest("hex");
  if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== oldHash) throw new Error("Hash mismatch");
  const before = raw.toString("utf8");
  const count = before.split(expected).length - 1;
  const required = input.expectedOccurrences || 1;
  if (count !== required) throw new Error("Occurrence mismatch: expected " + required + ", found " + count);
  const firstIndex = before.indexOf(expected);
  const line = firstIndex >= 0 ? before.slice(0, firstIndex).split(/\r?\n/).length : 1;
  const after = before.split(expected).join(String(input.replacementText ?? ""));
  if (input.previewOnly) {
    return { ok: true, path: target, markdownLink: toMarkdownLink(target, line), changed: false, previewOnly: true, oldHash, occurrences: count };
  }
  const latest = await fs.readFile(target);
  if (crypto.createHash("sha256").update(latest).digest("hex") !== oldHash) throw new Error("Concurrent modification");
  const temp = target + ".vcontinuity-" + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, after, "utf8");
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
  return {
    ok: true,
    path: target,
    markdownLink: toMarkdownLink(target, line),
    changed: true,
    occurrences: count,
    oldHash,
    newHash: crypto.createHash("sha256").update(after).digest("hex"),
  };
}

export async function writeText(input) {
  const target = await safePath(input.path);
  const content = String(input.content ?? "");
  if (content.length > 1000000) throw new Error("Content over 1MB");
  if (input.expectedSha256) {
    const current = await fs.readFile(target);
    const hash = crypto.createHash("sha256").update(current).digest("hex");
    if (hash !== input.expectedSha256.toLowerCase()) throw new Error("Hash mismatch");
  }
  if (input.createDirs) await fs.mkdir(path.dirname(target), { recursive: true });
  const bytes = Buffer.from(content, "utf8");
  await fs.writeFile(target, bytes, { flag: input.overwrite || input.expectedSha256 ? "w" : "wx" });
  return {
    ok: true,
    path: target,
    markdownLink: toMarkdownLink(target, 1),
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    written: true,
  };
}
