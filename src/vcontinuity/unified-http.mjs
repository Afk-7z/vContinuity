import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createVContinuityWebServer, VCONTINUITY_WEB_TOOL_NAMES } from "./web.mjs";
import { createVContinuityAgentServer } from "./agent.mjs";
import { loadOAuthConfig, createOAuthService } from "./oauth.mjs";
import { createDashboardHandler } from "./dashboard.mjs";
import { dataRoot } from "./data-root.mjs";
import { VCONTINUITY_VERSION } from "./version.mjs";
import { closeTransfer } from "./transfer.mjs";

const require = createRequire(import.meta.url);
const { createMcpHandler } = require("@modelcontextprotocol/server");
const { localhostHostValidation, toNodeHandler } = require("@modelcontextprotocol/node");

const PORT = Number(process.env.VCONTINUITY_PORT || 7781);
const HOST = "127.0.0.1";
const WEB_TOOL_COUNT = VCONTINUITY_WEB_TOOL_NAMES.length;
const AGENT_TOOL_COUNT = 1;
const MAX_REQUEST_BODY = 12 * 1024 * 1024;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("Invalid vContinuity MCP port");
process.env.VCONTINUITY_UNIFIED_MODE = "1";

const oauthConfig = await loadOAuthConfig();
const oauth = await createOAuthService(oauthConfig);
const PUBLIC_GATEWAY_PORT = oauthConfig.publicGatewayPort;
const OAUTH_ADMIN_PORT = oauthConfig.adminPort;

const runtimeStatusProvider = async () => {
  const state = await oauth.status();
  return {
    unified: true,
    mcpProcesses: 1,
    oauth: true,
    activeGrants: state.activeGrants,
    activeAccessTokens: state.activeAccessTokens,
    publicGatewayPort: PUBLIC_GATEWAY_PORT,
    adminPort: OAUTH_ADMIN_PORT,
  };
};

const createWebServer = () => createVContinuityWebServer({ runtimeStatusProvider });
const createAgentServer = () => createVContinuityAgentServer();

const webHandler = createMcpHandler(createWebServer, {
  legacy: "stateless",
  maxSubscriptions: 0,
  keepAliveMs: 0,
  onerror: (error) => console.error("[vcontinuity-web-mcp]", error),
});
const agentHandler = createMcpHandler(createAgentServer, {
  legacy: "stateless",
  maxSubscriptions: 0,
  keepAliveMs: 0,
  onerror: (error) => console.error("[vcontinuity-agent-mcp]", error),
});
const webNodeHandler = toNodeHandler(webHandler, { onerror: (error) => console.error("[vcontinuity-web-node]", error) });
const agentNodeHandler = toNodeHandler(agentHandler, { onerror: (error) => console.error("[vcontinuity-agent-node]", error) });
const validateHost = localhostHostValidation();

let readiness = { at: 0, result: null };

async function deploymentStatus() {
  try {
    const raw = await fs.readFile(path.join(dataRoot, "phase2-web-surface-result.json"), "utf8");
    const receipt = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return Boolean(receipt?.ok && receipt?.version === "0.7.0");
  } catch {
    return false;
  }
}

async function listSurfaceTools(pathname) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 991, method: "tools/list", params: {} });
  const response = await fetch("http://" + HOST + ":" + PORT + pathname, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": "tools/list" },
    body,
    signal: AbortSignal.timeout(6000),
  });
  if (response.status !== 200) throw new Error(pathname + " tools/list HTTP " + response.status);
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
  const rpc = JSON.parse(line ? line.slice(5).trimStart() : raw);
  if (rpc.error) throw new Error(pathname + " tools/list error: " + rpc.error.message);
  const tools = rpc.result?.tools;
  if (!Array.isArray(tools)) throw new Error(pathname + " tools/list returned no array");
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error(pathname + " duplicate tool names");
  return tools;
}

async function deepHealth() {
  if (readiness.result && Date.now() - readiness.at < 1800) return readiness.result;
  try {
    const [webTools, agentTools] = await Promise.all([
      listSurfaceTools("/mcp/web"),
      listSurfaceTools("/mcp/agent"),
    ]);
    const webNames = webTools.map((tool) => tool.name);
    if (webTools.length !== WEB_TOOL_COUNT) throw new Error("Web surface expected " + WEB_TOOL_COUNT + " tools");
    if (JSON.stringify(webNames) !== JSON.stringify(VCONTINUITY_WEB_TOOL_NAMES)) throw new Error("Web tool contract mismatch");
    if (agentTools.length !== 1 || agentTools[0]?.name !== "vcontinuity.work") throw new Error("Agent surface must expose only vcontinuity.work");
    const oauthState = await oauth.status();
    const result = {
      ok: true,
      service: "vcontinuity",
      version: VCONTINUITY_VERSION,
      unified: true,
      mcpProcesses: 1,
      webTools: webTools.length,
      agentTools: agentTools.length,
      computerUseTools: 0,
      surfaces: { legacyWebAlias: "/mcp", web: "/mcp/web", agent: "/mcp/agent" },
      oauth: {
        enabled: true,
        resource: oauth.resourceUrl,
        scopes: oauth.scopes,
        publicGatewayPort: PUBLIC_GATEWAY_PORT,
        adminPort: OAUTH_ADMIN_PORT,
        activeGrants: oauthState.activeGrants,
      },
      catalogReady: true,
      phase2Complete: await deploymentStatus(),
      tunnelReused: true,
    };
    readiness = { at: Date.now(), result };
    return result;
  } catch (error) {
    console.error("[vcontinuity] readiness:", error.message);
    const result = {
      ok: false,
      service: "vcontinuity",
      version: VCONTINUITY_VERSION,
      unified: true,
      catalogReady: false,
      reason: "mcp_catalog_unavailable",
      detail: error.message,
    };
    readiness = { at: Date.now(), result };
    return result;
  }
}

function enforceJsonRequest(req, res) {
  if (req.method !== "POST") return true;
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    res.writeHead(415, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "unsupported_media_type" }));
    return false;
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_REQUEST_BODY) {
    res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!validateHost(req, res)) return;
    const url = new URL(req.url || "/", "http://" + String(req.headers.host || "localhost"));
    if (req.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
      const health = await deepHealth();
      res.writeHead(health.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(health));
      return;
    }
    const handler = url.pathname === "/mcp/agent"
      ? agentNodeHandler
      : (url.pathname === "/mcp" || url.pathname === "/mcp/web") ? webNodeHandler : null;
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!enforceJsonRequest(req, res)) return;
    await handler(req, res);
  } catch (error) {
    console.error("[vcontinuity-local]", error.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});

const publicServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", oauth.publicOrigin);
    if (await oauth.handlePublicRequest(req, res, url)) return;
    if (req.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
      const status = await oauth.status();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        service: "vcontinuity-web-oauth",
        version: VCONTINUITY_VERSION,
        oauth: true,
        resource: oauth.resourceUrl,
        webTools: WEB_TOOL_COUNT,
        agentTools: AGENT_TOOL_COUNT,
        phase2Complete: await deploymentStatus(),
        activeGrants: status.activeGrants,
      }));
      return;
    }
    if (url.pathname === "/mcp/agent") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/mcp/web") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (!await oauth.verifyBearerRequest(req, res)) return;
    if (!enforceJsonRequest(req, res)) return;
    await webNodeHandler(req, res);
  } catch (error) {
    console.error("[vcontinuity-public-oauth]", error.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});
publicServer.keepAliveTimeout = 65000;
publicServer.headersTimeout = 66000;
publicServer.requestTimeout = 0;
publicServer.maxHeadersCount = 64;

const handleDashboardRequest = createDashboardHandler({
  oauth,
  ports: { mcp: PORT, admin: OAUTH_ADMIN_PORT, publicGateway: PUBLIC_GATEWAY_PORT },
  getDeepHealth: deepHealth,
});

const adminServer = http.createServer(async (req, res) => {
  try {
    if (!validateHost(req, res)) return;
    const url = new URL(req.url || "/", "http://127.0.0.1:" + OAUTH_ADMIN_PORT);
    if (await handleDashboardRequest(req, res, url)) return;
    if (await oauth.handleAdminRequest(req, res, url)) return;
    res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    console.error("[vcontinuity-oauth-admin]", error.message);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    if (!res.writableEnded) res.end(JSON.stringify({ error: "internal_error" }));
  }
});
adminServer.keepAliveTimeout = 65000;
adminServer.headersTimeout = 66000;
adminServer.requestTimeout = 0;
adminServer.maxHeadersCount = 32;

for (const item of [server, publicServer, adminServer]) {
  item.keepAliveTimeout = 65000;
  item.headersTimeout = 66000;
  item.requestTimeout = 0;
}

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, HOST, resolve);
});
await new Promise((resolve, reject) => {
  publicServer.once("error", reject);
  publicServer.listen(PUBLIC_GATEWAY_PORT, HOST, resolve);
});
await new Promise((resolve, reject) => {
  adminServer.once("error", reject);
  adminServer.listen(OAUTH_ADMIN_PORT, HOST, resolve);
});

console.error("[vcontinuity] listening " + HOST + ":" + PORT + " version=" + VCONTINUITY_VERSION + " webTools=" + WEB_TOOL_COUNT + " agentTools=" + AGENT_TOOL_COUNT);
console.error("[vcontinuity-oauth] public gateway " + HOST + ":" + PUBLIC_GATEWAY_PORT + " resource=" + oauth.resourceUrl);
console.error("[vcontinuity-oauth] local approvals http://127.0.0.1:" + OAUTH_ADMIN_PORT + "/");

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  try {
    await Promise.all([webHandler.close(), agentHandler.close()]);
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => publicServer.close(resolve)),
      new Promise((resolve) => adminServer.close(resolve)),
    ]);
    await closeTransfer();
  } finally {
    console.error("[vcontinuity] stopped " + signal);
  }
}
process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));
