import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(target) {
  try {
    const st = await fs.stat(target);
    return { exists: true, isDirectory: st.isDirectory(), isFile: st.isFile() };
  } catch {
    return { exists: false, isDirectory: false, isFile: false };
  }
}

async function readJsonSafe(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return { exists: true, valid: true, data: JSON.parse(raw.replace(/^\uFEFF/, "")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, valid: false, data: null };
    return {
      exists: true,
      valid: false,
      errorKind: error instanceof SyntaxError ? "invalid_json" : (error?.code || "read_error"),
      data: null,
    };
  }
}

async function probeCommand(cmd, args = ["--version"]) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: 5000,
      windowsHide: true,
    });
    const firstLine = String(stdout || stderr || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
    return { ok: true, version: firstLine.slice(0, 120) };
  } catch (error) {
    return { ok: false, error: error?.code === "ENOENT" ? "not_found" : (error?.code || "exec_failed") };
  }
}

async function probeNpm() {
  if (process.env.npm_execpath) {
    const viaExecPath = await probeCommand(process.execPath, [process.env.npm_execpath, "--version"]);
    if (viaExecPath.ok) return viaExecPath;
  }
  if (process.platform === "win32") {
    const viaCmd = await probeCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm --version"]);
    if (viaCmd.ok) return viaCmd;
  }
  return probeCommand("npm", ["--version"]);
}

async function findPlaywrightBrowser() {
  let pwAvailable = false;
  let defaultExe = null;
  try {
    const { chromium } = await import("playwright-core");
    pwAvailable = true;
    try {
      const candidate = chromium.executablePath();
      if (candidate && await exists(candidate)) defaultExe = candidate;
    } catch {}
  } catch {}

  const candidates = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    candidates.push({ source: "env", path: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  }
  if (defaultExe) {
    candidates.push({ source: "playwright-default", path: defaultExe });
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const msPwRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(localAppData, "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);

  for (const msPw of msPwRoots) {
    try {
      const entries = (await fs.readdir(msPw)).sort().reverse();
      for (const entry of entries) {
        if (/^chromium_headless_shell-/.test(entry)) {
          candidates.push({
            source: "ms-playwright-cache",
            path: path.join(msPw, entry, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
          });
          candidates.push({
            source: "ms-playwright-cache",
            path: path.join(msPw, entry, "chrome-headless-shell-linux64", "chrome-headless-shell"),
          });
        } else if (/^chromium-/.test(entry)) {
          candidates.push({
            source: "ms-playwright-cache",
            path: path.join(msPw, entry, "chrome-win64", "chrome.exe"),
          });
          candidates.push({
            source: "ms-playwright-cache",
            path: path.join(msPw, entry, "chrome-linux64", "chrome"),
          });
        }
      }
    } catch {}
  }

  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "";
    const pf86 = process.env["ProgramFiles(x86)"] || "";
    if (pf) {
      candidates.push({ source: "system-chrome", path: path.join(pf, "Google", "Chrome", "Application", "chrome.exe") });
      candidates.push({ source: "system-edge", path: path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe") });
    }
    if (pf86) {
      candidates.push({ source: "system-edge-x86", path: path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe") });
      candidates.push({ source: "system-chrome-x86", path: path.join(pf86, "Google", "Chrome", "Application", "chrome.exe") });
    }
  }

  const found = [];
  for (const item of candidates) {
    if (item.path && await exists(item.path)) {
      found.push({ source: item.source, available: true });
    }
  }

  return {
    playwrightCoreInstalled: pwAvailable,
    browserExecutableFound: found.length > 0,
    sources: [...new Set(found.map((x) => x.source))],
  };
}

async function findCloudflared() {
  if (process.env.VCONTINUITY_CLOUDFLARED) {
    const st = await statSafe(process.env.VCONTINUITY_CLOUDFLARED);
    if (st.isFile) {
      const probe = await probeCommand(process.env.VCONTINUITY_CLOUDFLARED, ["--version"]);
      return { available: true, source: "env", version: probe.version || null };
    }
    return { available: false, optional: true, source: "env", reason: "configured_path_missing" };
  }

  const inPath = await probeCommand("cloudflared", ["--version"]);
  if (inPath.ok) {
    return { available: true, source: "path", version: inPath.version || null };
  }

  const downloadsDir = path.join(os.homedir(), "Downloads");
  try {
    const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("tunnel-client-runtime-cloudflared")) continue;
      const bin = path.join(downloadsDir, entry.name, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
      if (await exists(bin)) {
        const probe = await probeCommand(bin, ["--version"]);
        return { available: true, source: "downloads-runtime", version: probe.version || null };
      }
    }
  } catch {}

  return { available: false, optional: true, source: "none" };
}

async function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function inspectPort(role, port, probePath, validatePayload, fallback) {
  const listening = await isPortListening(port);
  if (!listening) {
    return { role, port, status: "available", occupiedBy: null };
  }
  try {
    const probe = async (route) => {
      const response = await fetch("http://127.0.0.1:" + port + route, { signal: AbortSignal.timeout(1500) });
      return { status: response.status, data: await response.json().catch(() => null) };
    };
    let { status, data } = await probe(probePath);
    let valid = data && validatePayload(data);
    if (fallback && status === 404) {
      ({ status, data } = await probe(fallback.path));
      valid = data && fallback.validate(data);
    }
    if ([200, 503].includes(status) && valid) {
      return {
        role,
        port,
        status: "listening_vcontinuity",
        occupiedBy: "vcontinuity",
        serviceOk: Boolean(data.ok),
        version: data.version || null,
      };
    }
    return {
      role,
      port,
      status: "occupied_other",
      occupiedBy: "other_process",
      httpStatus: status,
    };
  } catch {
    return {
      role,
      port,
      status: "occupied_other",
      occupiedBy: "other_process",
    };
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeCheck = {
  ok: nodeMajor >= 22,
  version: process.version,
  required: ">=22",
};

const [npmCheck, gitCheck, rgCheck, psCheck, browserCheck, cloudflaredCheck] = await Promise.all([
  probeNpm(),
  probeCommand("git", ["--version"]),
  probeCommand("rg", ["--version"]),
  process.platform === "win32"
    ? probeCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"])
    : probeCommand("pwsh", ["--version"]),
  findPlaywrightBrowser(),
  findCloudflared(),
]);

const dataRoot = process.env.VCONTINUITY_DATA_ROOT
  ? path.resolve(process.env.VCONTINUITY_DATA_ROOT)
  : path.join(projectRoot, "data");
const fileRoot = process.env.VCONTINUITY_FILE_ROOT
  ? path.resolve(process.env.VCONTINUITY_FILE_ROOT)
  : path.join(os.homedir(), "Documents", "ChatGPT Media");
const configFile = process.env.VCONTINUITY_CONFIG
  ? path.resolve(process.env.VCONTINUITY_CONFIG)
  : path.join(projectRoot, "vcontinuity.config.json");

const parsedConfig = await readJsonSafe(configFile);
const defaultWorkspaceRoots = [
  projectRoot,
  path.join(os.homedir(), "Documents"),
  path.join(os.homedir(), "Projects"),
  path.join(os.homedir(), "Downloads"),
  path.join(os.homedir(), "Desktop"),
];
const hasExplicitRoots = parsedConfig.exists && parsedConfig.valid && Object.hasOwn(parsedConfig.data || {}, "workspaceRoots");
const explicitRootsValid = !hasExplicitRoots || (Array.isArray(parsedConfig.data.workspaceRoots) && parsedConfig.data.workspaceRoots.length > 0);
const configuredRoots = Array.isArray(parsedConfig.data?.workspaceRoots)
  ? parsedConfig.data.workspaceRoots
  : defaultWorkspaceRoots;

const workspaceRootsStatus = await Promise.all(configuredRoots.map(async (rootEntry) => {
  const resolved = path.resolve(String(rootEntry));
  const st = await statSafe(resolved);
  return { exists: st.exists, isDirectory: st.isDirectory };
}));

const [dataRootStat, worksStat, jobsStat, oauthDirStat, fileRootStat] = await Promise.all([
  statSafe(dataRoot),
  statSafe(path.join(dataRoot, "works")),
  statSafe(path.join(dataRoot, "jobs")),
  statSafe(path.join(dataRoot, "oauth")),
  statSafe(fileRoot),
]);

const oauthConfigFile = process.env.VCONTINUITY_OAUTH_CONFIG
  ? path.resolve(process.env.VCONTINUITY_OAUTH_CONFIG)
  : path.join(dataRoot, "oauth", "config.json");
const oauthStorageRoot = process.env.VCONTINUITY_OAUTH_STORAGE_ROOT
  ? path.resolve(process.env.VCONTINUITY_OAUTH_STORAGE_ROOT)
  : null;

const parsedOAuthConfig = await readJsonSafe(oauthConfigFile);
const effectiveOAuthStorage = oauthStorageRoot
  || (parsedOAuthConfig.data?.storageRoot ? path.resolve(parsedOAuthConfig.data.storageRoot) : path.join(dataRoot, "oauth"));

const [clientsDoc, grantsDoc, tokensDoc] = await Promise.all([
  readJsonSafe(path.join(effectiveOAuthStorage, "clients.json")),
  readJsonSafe(path.join(effectiveOAuthStorage, "grants.json")),
  readJsonSafe(path.join(effectiveOAuthStorage, "tokens.json")),
]);

const effectivePublicOrigin = process.env.VCONTINUITY_PUBLIC_ORIGIN || parsedOAuthConfig.data?.publicOrigin || "";
let publicOriginValid = false;
let publicOriginProtocol = null;
if (effectivePublicOrigin) {
  try {
    const u = new URL(effectivePublicOrigin);
    publicOriginProtocol = u.protocol;
    publicOriginValid = u.protocol === "https:";
  } catch {}
}

const mcpPort = Number(process.env.VCONTINUITY_PORT || 7781);
const adminPort = Number(process.env.VCONTINUITY_ADMIN_PORT || parsedOAuthConfig.data?.adminPort || 7783);
const publicGatewayPort = Number(process.env.VCONTINUITY_PUBLIC_GATEWAY_PORT || parsedOAuthConfig.data?.publicGatewayPort || 7791);

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;
const legacyAdmin = {
  path: "/api/overview",
  validate: (data) => data.ports?.admin === adminPort && data.health?.service === "vcontinuity"
    && Array.isArray(data.webToolNames) && data.webToolNames.includes("vcontinuity.work"),
};

const ports = await Promise.all([
  validPort(mcpPort) ? inspectPort("mcp", mcpPort, "/healthz", (j) => j.service === "vcontinuity") : { role: "mcp", port: mcpPort, status: "invalid_port", occupiedBy: null },
  validPort(adminPort) ? inspectPort("admin", adminPort, "/healthz", (j) => j.service === "vcontinuity-admin", legacyAdmin) : { role: "admin", port: adminPort, status: "invalid_port", occupiedBy: null },
  validPort(publicGatewayPort) ? inspectPort("publicGateway", publicGatewayPort, "/healthz", (j) => j.service === "vcontinuity-web-oauth") : { role: "publicGateway", port: publicGatewayPort, status: "invalid_port", occupiedBy: null },
]);

const rawTokenLeaks = Array.isArray(tokensDoc.data?.tokens)
  ? tokensDoc.data.tokens.some((t) => Object.hasOwn(t, "token") || Object.hasOwn(t, "access_token") || Object.hasOwn(t, "refresh_token"))
  : false;

const warnings = [];
const errors = [];

if (!nodeCheck.ok) errors.push("Node.js >= 22 required");
if (!npmCheck.ok) warnings.push("npm unavailable — package script commands may fail");
if (!gitCheck.ok) warnings.push("git not found in PATH — vcontinuity.git operations will be unavailable");
if (!rgCheck.ok) warnings.push("ripgrep (rg) not found in PATH — vcontinuity.fs_search will be unavailable");
if (process.platform === "win32" && !psCheck.ok) warnings.push("powershell.exe unavailable — PowerShell commands in vcontinuity.exec/job will fail");
if (parsedConfig.exists && !parsedConfig.valid) errors.push("Invalid JSON in vcontinuity config");
if (!explicitRootsValid) errors.push("workspaceRoots in vcontinuity config must be a non-empty array");
if (parsedOAuthConfig.exists && !parsedOAuthConfig.valid) errors.push("Invalid JSON in OAuth config");
if (clientsDoc.exists && !clientsDoc.valid) errors.push("Invalid JSON in OAuth clients store");
if (grantsDoc.exists && !grantsDoc.valid) errors.push("Invalid JSON in OAuth grants store");
if (tokensDoc.exists && !tokensDoc.valid) errors.push("Invalid JSON in OAuth tokens store");
if (effectivePublicOrigin && !publicOriginValid) errors.push("Configured OAuth publicOrigin must use HTTPS");
if (rawTokenLeaks) errors.push("OAuth tokens store contains unhashed token fields");
for (const p of ports) {
  if (p.status === "invalid_port") {
    errors.push("Invalid configured port for " + p.role);
  }
  if (p.status === "occupied_other") {
    errors.push("Port " + p.port + " (" + p.role + ") is occupied by another process");
  }
  if (p.status === "listening_vcontinuity" && p.serviceOk === false) {
    warnings.push("vContinuity " + p.role + " on port " + p.port + " responded with ok=false");
  }
}
if (workspaceRootsStatus.some((r) => !r.isDirectory)) {
  warnings.push("One or more configured workspaceRoots directories do not exist on disk");
}
if (!browserCheck.playwrightCoreInstalled || !browserCheck.browserExecutableFound) {
  warnings.push("Playwright browser executable not found — run 'npx playwright-core install chromium' or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH for npm run test:browser");
}
if (!effectivePublicOrigin) {
  warnings.push("OAuth publicOrigin not configured — set VCONTINUITY_PUBLIC_ORIGIN or data/oauth/config.json before starting the unified runtime");
}

const report = {
  ok: errors.length === 0,
  readOnly: true,
  platform: process.platform,
  tools: {
    node: nodeCheck,
    npm: npmCheck,
    git: gitCheck,
    rg: rgCheck,
    powershell: { ...psCheck, requiredOnWindows: true },
    browser: browserCheck,
    cloudflared: cloudflaredCheck,
  },
  roots: {
    configSource: process.env.VCONTINUITY_CONFIG ? "env" : (parsedConfig.exists ? "file" : "defaults"),
    configValid: !parsedConfig.exists || parsedConfig.valid,
    configErrorKind: parsedConfig.errorKind || null,
    workspaceRootsCount: workspaceRootsStatus.length,
    workspaceRootsExisting: workspaceRootsStatus.filter((r) => r.isDirectory).length,
    dataRoot: {
      source: process.env.VCONTINUITY_DATA_ROOT ? "env" : "default",
      exists: dataRootStat.isDirectory,
      subdirs: {
        works: worksStat.isDirectory,
        jobs: jobsStat.isDirectory,
        oauth: oauthDirStat.isDirectory,
      },
    },
    fileRoot: {
      source: process.env.VCONTINUITY_FILE_ROOT ? "env" : "default",
      exists: fileRootStat.isDirectory,
    },
  },
  oauth: {
    configSource: process.env.VCONTINUITY_PUBLIC_ORIGIN
      ? "env"
      : (parsedOAuthConfig.exists ? "file" : "unconfigured"),
    configValid: !parsedOAuthConfig.exists || parsedOAuthConfig.valid,
    configErrorKind: parsedOAuthConfig.errorKind || null,
    publicOriginConfigured: Boolean(effectivePublicOrigin),
    publicOriginHttps: publicOriginValid,
    publicOriginProtocol,
    stores: {
      clients: {
        exists: clientsDoc.exists,
        valid: !clientsDoc.exists || clientsDoc.valid,
        errorKind: clientsDoc.errorKind || null,
        count: Array.isArray(clientsDoc.data?.clients) ? clientsDoc.data.clients.length : 0,
      },
      grants: {
        exists: grantsDoc.exists,
        valid: !grantsDoc.exists || grantsDoc.valid,
        errorKind: grantsDoc.errorKind || null,
        activeCount: Array.isArray(grantsDoc.data?.grants) ? grantsDoc.data.grants.filter((g) => !g.revokedAt).length : 0,
        revokedCount: Array.isArray(grantsDoc.data?.grants) ? grantsDoc.data.grants.filter((g) => Boolean(g.revokedAt)).length : 0,
      },
      tokens: {
        exists: tokensDoc.exists,
        valid: !tokensDoc.exists || tokensDoc.valid,
        errorKind: tokensDoc.errorKind || null,
        count: Array.isArray(tokensDoc.data?.tokens) ? tokensDoc.data.tokens.length : 0,
        rawTokensDetected: rawTokenLeaks,
      },
    },
  },
  ports,
  warnings,
  errors,
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
