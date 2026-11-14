import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDirs = new Set([".git", "node_modules", "data"]);
const skipFiles = new Set(["vcontinuity.config.json"]);
const textExts = new Set([".mjs", ".js", ".json", ".md", ".ps1", ".cmd", ".yml", ".yaml", ".txt", ".html", ".css"]);
const findings = [];
const escapeRegex = (value) => value.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
const username = escapeRegex(os.userInfo().username);

const patterns = [
  { name: "user-specific Windows path", re: new RegExp("C:\\\\Users\\\\" + username + "(?:\\\\|$)", "i") },
  { name: "literal Windows user path", re: /C:\\Users\\(?!YOUR_USER(?:\\|$))[^\s"'<>]+/i },
  { name: "private Tailscale hostname", re: /https:\/\/[A-Za-z0-9.-]+\.ts\.net\b/i },
  { name: "connection identifier", re: /\bconn_[A-Za-z0-9]{12,}\b/ },
  { name: "private key material", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "literal bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}={0,2}\b/i },
];

async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (skipFiles.has(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!textExts.has(ext) && !entry.name.startsWith(".")) continue;
    let content;
    try { content = await fs.readFile(full, "utf8"); } catch { continue; }
    for (const pattern of patterns) {
      if (pattern.re.test(content)) findings.push({ file: rel, issue: pattern.name });
    }
  }
}

await walk(root);

for (const forbidden of [".env", ".env.local", ".env.production"]) {
  try {
    await fs.access(path.join(root, forbidden));
    findings.push({ file: forbidden, issue: "environment file present at repository root" });
  } catch {}
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  root,
  scannedFor: patterns.map((item) => item.name),
  excludedLocalState: ["data/", "node_modules/", "vcontinuity.config.json"],
}));
