import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PUBLIC_ORIGIN = "https://vcontinuity.example.test";

async function allocatePorts(count = 3) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const srv = net.createServer();
      await new Promise((resolve, reject) => {
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", resolve);
      });
      servers.push(srv);
    }
    return servers.map((srv) => srv.address().port);
  } finally {
    await Promise.all(servers.map((srv) => new Promise((resolve) => srv.close(() => resolve()))));
  }
}

async function removeWithRetry(targetDir) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.rm(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 7) return;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
}

async function waitWithTimeout(promise, ms) {
  let timer = null;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateChildProcess(child, exitPromise, isExited) {
  if (!isExited()) {
    try { child.kill("SIGTERM"); } catch {}
    await waitWithTimeout(exitPromise, 3500);
  }
  if (!isExited()) {
    if (process.platform === "win32" && child.pid) {
      await new Promise((resolve) => {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => resolve());
      });
    }
    try { child.kill("SIGKILL"); } catch {}
    await waitWithTimeout(exitPromise, 2000);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
}

export async function createIsolatedEnv({
  prefix = "vcontinuity-iso-",
  includeProjectRoot = true,
  publicOrigin = DEFAULT_PUBLIC_ORIGIN,
  resourcePath = "/mcp/web",
  applyToProcess = false,
} = {}) {
  // Windows runners can expose TEMP through a short (8.3) path.
  const tmpRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix));
  const dataRoot = path.join(tmpRoot, "data");
  const oauthDir = path.join(dataRoot, "oauth");
  const worksDir = path.join(dataRoot, "works");
  const jobsDir = path.join(dataRoot, "jobs");
  const fileRoot = path.join(tmpRoot, "files");
  const workspaceRoot = path.join(tmpRoot, "workspace");
  const configPath = path.join(tmpRoot, "vcontinuity.config.json");
  const oauthConfigPath = path.join(oauthDir, "config.json");

  await Promise.all([
    fs.mkdir(oauthDir, { recursive: true }),
    fs.mkdir(worksDir, { recursive: true }),
    fs.mkdir(jobsDir, { recursive: true }),
    fs.mkdir(fileRoot, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true }),
  ]);

  const [mcpPort, adminPort, publicGatewayPort] = await allocatePorts(3);
  const workspaceRoots = includeProjectRoot ? [workspaceRoot, projectRoot] : [workspaceRoot];

  await fs.writeFile(configPath, JSON.stringify({
    workspaceRoots,
    defaultCwd: workspaceRoot,
    maxOutputChars: 150000,
    maxReadChars: 400000,
    maxConcurrent: 16,
  }, null, 2) + "\n", "utf8");

  await fs.writeFile(oauthConfigPath, JSON.stringify({
    publicOrigin,
    resourcePath,
    publicGatewayPort,
    adminPort,
    storageRoot: oauthDir,
  }, null, 2) + "\n", "utf8");

  const envVars = {
    VCONTINUITY_DATA_ROOT: dataRoot,
    VCONTINUITY_FILE_ROOT: fileRoot,
    VCONTINUITY_CONFIG: configPath,
    VCONTINUITY_OAUTH_CONFIG: oauthConfigPath,
    VCONTINUITY_OAUTH_STORAGE_ROOT: oauthDir,
    VCONTINUITY_PUBLIC_ORIGIN: publicOrigin,
    VCONTINUITY_RESOURCE_PATH: resourcePath,
    VCONTINUITY_PORT: String(mcpPort),
    VCONTINUITY_ADMIN_PORT: String(adminPort),
    VCONTINUITY_PUBLIC_GATEWAY_PORT: String(publicGatewayPort),
  };

  const previousEnv = {};
  if (applyToProcess) {
    for (const [key, value] of Object.entries(envVars)) {
      previousEnv[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined;
      process.env[key] = value;
    }
  }

  return {
    tmpRoot,
    dataRoot,
    oauthDir,
    worksDir,
    jobsDir,
    fileRoot,
    workspaceRoot,
    configPath,
    oauthConfigPath,
    publicOrigin,
    resourcePath,
    resourceUrl: publicOrigin.replace(/\/$/, "") + resourcePath,
    ports: { mcp: mcpPort, admin: adminPort, publicGateway: publicGatewayPort },
    env: { ...process.env, ...envVars },
    envVars,
    async cleanup() {
      if (applyToProcess) {
        for (const [key, oldVal] of Object.entries(previousEnv)) {
          if (oldVal === undefined) delete process.env[key];
          else process.env[key] = oldVal;
        }
      }
      await removeWithRetry(tmpRoot);
    },
  };
}

export async function startIsolatedRuntime(options = {}) {
  const iso = await createIsolatedEnv({ ...options, applyToProcess: false });
  if (typeof options.beforeLaunch === "function") {
    try {
      await options.beforeLaunch(iso);
    } catch (error) {
      await iso.cleanup();
      throw error;
    }
  }
  const entry = path.join(projectRoot, "src", "vcontinuity", "unified-http.mjs");
  const child = spawn(process.execPath, [entry], {
    cwd: iso.workspaceRoot,
    env: iso.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  const appendLog = (chunk) => {
    logs = (logs + chunk.toString("utf8")).slice(-16384);
  };
  child.stdout?.on("data", appendLog);
  child.stderr?.on("data", appendLog);

  let exited = false;
  let exitCode = null;
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code ?? signal;
      resolve({ code, signal });
    });
  });

  const mcpUrl = "http://127.0.0.1:" + iso.ports.mcp;
  const adminUrl = "http://127.0.0.1:" + iso.ports.admin;
  const gatewayUrl = "http://127.0.0.1:" + iso.ports.publicGateway;

  const deadline = Date.now() + (options.startupTimeoutMs || 25000);
  let ready = false;
  try {
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error("Isolated vContinuity exited early (" + exitCode + "):\n" + logs);
      }
      try {
        const [healthRes, adminRes, gwRes] = await Promise.all([
          fetch(mcpUrl + "/healthz", { signal: AbortSignal.timeout(2000) }),
          fetch(adminUrl + "/", { signal: AbortSignal.timeout(2000) }),
          fetch(gatewayUrl + "/.well-known/oauth-protected-resource", { signal: AbortSignal.timeout(2000) }),
        ]);
        if (healthRes.status === 200 && adminRes.status === 200 && gwRes.status === 200) {
          const health = await healthRes.json();
          if (health.ok && health.oauth?.enabled) {
            ready = true;
            break;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) {
      throw new Error("Timed out waiting for isolated vContinuity runtime on port " + iso.ports.mcp + "\nLogs:\n" + logs);
    }
  } catch (error) {
    await terminateChildProcess(child, exitPromise, () => exited);
    await iso.cleanup();
    throw error;
  }

  return {
    ...iso,
    mcpUrl,
    adminUrl,
    gatewayUrl,
    getLogs: () => logs,
    async stop() {
      await terminateChildProcess(child, exitPromise, () => exited);
      await iso.cleanup();
    },
  };
}
