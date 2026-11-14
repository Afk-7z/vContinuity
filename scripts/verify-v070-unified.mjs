import assert from "node:assert/strict";
import { VCONTINUITY_WEB_TOOL_NAMES } from "../src/vcontinuity/web.mjs";
import { startIsolatedRuntime } from "./isolated-runtime.mjs";

const runtime = await startIsolatedRuntime({ prefix: "vcontinuity-parity-" });
const origin = runtime.mcpUrl;

async function rpc(pathname, method, params = {}, id = 1) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-method": method };
  if (method === "tools/call") headers["mcp-name"] = params.name;
  const response = await fetch(origin + pathname, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
  return { status: response.status, rpc: raw ? JSON.parse(line ? line.slice(5).trimStart() : raw) : null };
}

async function names(pathname, id) {
  const init = await rpc(pathname, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vcontinuity-v070-verifier", version: "0.7.0" },
  }, id);
  assert.equal(init.status, 200);
  assert.equal(init.rpc.result?.serverInfo?.name, "vcontinuity");
  assert.equal(init.rpc.result?.serverInfo?.version, "0.7.0");
  const listed = await rpc(pathname, "tools/list", {}, id + 1);
  assert.equal(listed.status, 200);
  return listed.rpc.result.tools.map((tool) => tool.name);
}

try {
  assert.deepEqual(await names("/mcp/web", 1), [...VCONTINUITY_WEB_TOOL_NAMES]);
  assert.deepEqual(await names("/mcp", 10), [...VCONTINUITY_WEB_TOOL_NAMES]);
  assert.deepEqual(await names("/mcp/agent", 20), ["vcontinuity.work"]);

  const response = await fetch(origin + "/healthz", { signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, "vcontinuity");
  assert.equal(health.version, "0.7.0");
  assert.equal(health.webTools, 13);
  assert.equal(health.agentTools, 1);
  assert.equal(health.computerUseTools, 0);
  assert.equal(health.oauth?.enabled, true);

  const toolHealth = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.health", arguments: { nonce: "parity" },
  }, 40);
  assert.equal(toolHealth.rpc.result?.structuredContent?.version, "0.7.0");
  assert.equal(toolHealth.rpc.result?.structuredContent?.authenticated, false);
  assert.equal(toolHealth.rpc.result?.structuredContent?.capabilities?.computerUse, false);

  const project = await rpc("/mcp/web", "tools/call", { name: "vcontinuity.project", arguments: { cwd: runtime.workspaceRoot } }, 41);
  assert.equal(project.rpc.result?.structuredContent?.ok, true);
  const work = await rpc("/mcp/web", "tools/call", { name: "vcontinuity.work", arguments: { action: "list", limit: 3 } }, 42);
  assert.equal(work.rpc.result?.structuredContent?.ok, true);
assert.equal(work.rpc.result?.structuredContent?.count, 0);
assert.equal(project.rpc.result?.structuredContent?.continuity?.status, "unregistered");

async function callWork(args, session, id) {
  return (await rpc("/mcp/agent", "tools/call", {
    name: "vcontinuity.work", arguments: args, _meta: { "vcontinuity/session": session },
  }, id)).rpc.result?.structuredContent;
}
assert.equal((await callWork({ action: "create", workId: "first-session" }, "session-a", 44)).ok, true);
assert.equal((await callWork({ action: "create", workId: "second-session" }, "session-b", 45)).ok, true);
assert.equal((await callWork({ action: "status" }, "session-a", 46)).active?.workId, "first-session");
assert.equal((await callWork({ action: "status" }, "session-b", 47)).active?.workId, "second-session");
  const exec = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.exec",
    arguments: { command: [process.execPath, "--version"], cwd: runtime.workspaceRoot },
  }, 43);
  assert.equal(exec.rpc.result?.structuredContent?.exitCode, 0);

  console.log(JSON.stringify({
    ok: true, version: "0.7.0", webTools: 13, agentTools: 1,
    exactToolContract: true, oauthConfigured: true, computerUseDeferred: true, isolated: true,
  }));
} finally {
  await runtime.stop();
}
