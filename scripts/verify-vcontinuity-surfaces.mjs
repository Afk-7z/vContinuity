import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { createIsolatedEnv, projectRoot } from "./isolated-runtime.mjs";

const iso = await createIsolatedEnv({ prefix: "vcontinuity-surfaces-", applyToProcess: true });
const { createVContinuityWebServer, VCONTINUITY_WEB_TOOL_NAMES } = await import("../src/vcontinuity/web.mjs");
const { createVContinuityAgentServer } = await import("../src/vcontinuity/agent.mjs");
const { fileTransferService } = await import("../src/vcontinuity/file-transfer-service.mjs");

const require = createRequire(import.meta.url);
const { createMcpHandler } = require("@modelcontextprotocol/server");
const { toNodeHandler } = require("@modelcontextprotocol/node");

function mount(factory) {
  const handler = createMcpHandler(factory, { legacy: "stateless", maxSubscriptions: 0, keepAliveMs: 0 });
  return { handler, node: toNodeHandler(handler) };
}
const web = mount(() => createVContinuityWebServer());
const agent = mount(() => createVContinuityAgentServer());

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/web") return web.node(req, res);
  if (url.pathname === "/agent") return agent.node(req, res);
  res.writeHead(404); res.end();
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const origin = "http://127.0.0.1:" + server.address().port;
async function rpc(pathname, method, params = {}, id = 1) {
  const response = await fetch(origin + pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
      ...(method === "tools/call" && params.name ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
  return { status: response.status, rpc: JSON.parse(line ? line.slice(5).trimStart() : raw) };
}

try {
  const webInit = await rpc("/web", "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "vcontinuity-web-verifier", version: "1" },
  }, 1);
  assert.equal(webInit.status, 200);
  assert.equal(webInit.rpc.result?.serverInfo?.name, "vcontinuity");
  assert.equal(webInit.rpc.result?.serverInfo?.version, "0.7.0");
  assert.match(webInit.rpc.result?.instructions || "", /no external model\/agent runtime/i);

  const webList = await rpc("/web", "tools/list", {}, 2);
  const webNames = webList.rpc.result.tools.map((tool) => tool.name);
  assert.deepEqual(webNames, [...VCONTINUITY_WEB_TOOL_NAMES]);
  assert.equal(webNames.length, 13);
  assert.ok(webNames.every((name) => name.startsWith("vcontinuity.")));

  const agentList = await rpc("/agent", "tools/list", {}, 3);
  assert.deepEqual(agentList.rpc.result.tools.map((tool) => tool.name), ["vcontinuity.work"]);

  const project = await rpc("/web", "tools/call", { name: "vcontinuity.project", arguments: {} }, 4);
  assert.equal(project.rpc.result?.structuredContent?.ok, true);
  assert.equal(project.rpc.result?.structuredContent?.capabilities?.externalAgentRuntime, false);

  const health = await rpc("/web", "tools/call", { name: "vcontinuity.health", arguments: { nonce: "surface-check" } }, 5);
  assert.equal(health.rpc.result?.structuredContent?.nonce, "surface-check");
  assert.equal(health.rpc.result?.structuredContent?.webTools, 13);
  assert.equal(health.rpc.result?.structuredContent?.capabilities?.computerUse, false);

  const read = await rpc("/web", "tools/call", {
    name: "vcontinuity.fs_read",
    arguments: { paths: [path.join(projectRoot, "package.json")], maxChars: 5000 },
  }, 6);
  assert.equal(read.rpc.result?.structuredContent?.ok, true);
  assert.match(read.rpc.result?.structuredContent?.results?.[0]?.content || "", /vcontinuity/i);

  const exec = await rpc("/web", "tools/call", {
    name: "vcontinuity.exec",
    arguments: { command: [process.execPath, "--version"], cwd: iso.workspaceRoot },
  }, 7);
  assert.equal(exec.rpc.result?.structuredContent?.exitCode, 0);

  const batch = await rpc("/web", "tools/call", {
    name: "vcontinuity.exec",
    arguments: {
      commands: [
        { id: "a", command: [process.execPath, "-e", "process.stdout.write('A')"], cwd: iso.workspaceRoot },
        { id: "b", command: [process.execPath, "-e", "process.stdout.write('B')"], cwd: iso.workspaceRoot },
      ],
      mode: "parallel",
    },
  }, 8);
  assert.equal(batch.rpc.result?.structuredContent?.count, 2);

  const transfer = await rpc("/web", "tools/call", {
    name: "vcontinuity.transfer",
    arguments: { action: "workflow" },
  }, 9);
  assert.equal(transfer.rpc.result?.structuredContent?.owner, "vContinuity");
  assert.equal(transfer.rpc.result?.structuredContent?.transfer_tool, "vcontinuity.transfer");

  const work = await rpc("/web", "tools/call", {
    name: "vcontinuity.work",
    arguments: { action: "list", limit: 1 },
  }, 10);
  assert.equal(work.rpc.result?.structuredContent?.ok, true);

  const jobStart = await rpc("/web", "tools/call", {
    name: "vcontinuity.job",
    arguments: {
      action: "start",
      title: "surface-check",
      command: [process.execPath, "-e", "setTimeout(()=>console.log('JOB_OK'),100)"],
      cwd: iso.workspaceRoot,
      timeoutMs: 5000,
    },
  }, 11);
  const jobId = jobStart.rpc.result?.structuredContent?.jobId;
  assert.match(jobId || "", /^job_/);
  const jobWait = await rpc("/web", "tools/call", {
    name: "vcontinuity.job",
    arguments: { action: "wait", jobId, timeoutMs: 5000 },
  }, 12);
  assert.equal(jobWait.rpc.result?.structuredContent?.snapshots?.[0]?.status, "completed");

  console.log(JSON.stringify({
    ok: true,
    version: "0.7.0",
    webTools: webNames.length,
    agentTools: 1,
    exactToolContract: true,
    project: true,
    filesystem: true,
    execSingleAndBatch: true,
    jobs: true,
    transfer: true,
    workContext: true,
    computerUse: false,
  }));
} finally {
  await Promise.all([web.handler.close(), agent.handler.close()]).catch(() => {});
  await fileTransferService.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await iso.cleanup();
}
