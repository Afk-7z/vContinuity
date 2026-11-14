import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { createIsolatedEnv } from "./isolated-runtime.mjs";

const iso = await createIsolatedEnv({ prefix: "vcontinuity-agent-surface-", applyToProcess: true });
const { createVContinuityAgentServer } = await import("../src/vcontinuity/agent.mjs");

const require = createRequire(import.meta.url);
const { createMcpHandler } = require("@modelcontextprotocol/server");
const { toNodeHandler } = require("@modelcontextprotocol/node");

const handler = createMcpHandler(createVContinuityAgentServer, { legacy: "stateless", maxSubscriptions: 0, keepAliveMs: 0 });
const nodeHandler = toNodeHandler(handler);
const server = http.createServer((req, res) => nodeHandler(req, res));
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

try {
  const origin = "http://127.0.0.1:" + server.address().port;
  async function rpc(method, params = {}, id = 1) {
    const response = await fetch(origin, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": method,
        ...(method === "tools/call" && params.name ? { "mcp-name": params.name } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
    return { status: response.status, rpc: JSON.parse(line ? line.slice(5).trimStart() : raw) };
  }

  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vcontinuity-agent-verifier", version: "0.7.0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.rpc.result?.serverInfo?.version, "0.7.0");
  assert.match(init.rpc.result?.serverInfo?.description || "", /local-agent context surface/i);

  const listed = await rpc("tools/list", {}, 2);
  const names = listed.rpc.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["vcontinuity.work"]);

  const work = await rpc("tools/call", { name: "vcontinuity.work", arguments: { action: "list", limit: 1 } }, 3);
  assert.equal(work.rpc.result?.structuredContent?.ok, true);

  console.log(JSON.stringify({ ok: true, version: "0.7.0", tools: names, exactToolContract: true }));
} finally {
  await handler.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  await iso.cleanup();
}
