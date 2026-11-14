import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { OAUTH_SCOPES } from "../src/vcontinuity/oauth.mjs";
import { VCONTINUITY_WEB_TOOL_NAMES } from "../src/vcontinuity/web.mjs";
import { startIsolatedRuntime } from "./isolated-runtime.mjs";
import { createOAuthTestClient } from "./oauth-v070-lib.mjs";

const runtime = await startIsolatedRuntime({ prefix: "vcontinuity-oauth-" });
const {
  gateway, publicOrigin, resource, rpc, registerClient, authorize, revokeConnection,
} = createOAuthTestClient({
  gateway: runtime.gatewayUrl,
  admin: runtime.adminUrl,
  publicOrigin: runtime.publicOrigin,
  resource: runtime.resourceUrl,
});

try {
  const protectedResponse = await fetch(gateway + "/.well-known/oauth-protected-resource", { signal: AbortSignal.timeout(8000) });
  assert.equal(protectedResponse.status, 200);
  const protectedMetadata = await protectedResponse.json();
  assert.equal(protectedMetadata.resource, resource);
  assert.deepEqual(protectedMetadata.authorization_servers, [publicOrigin]);
  assert.deepEqual(protectedMetadata.scopes_supported, OAUTH_SCOPES);

  const serverResponse = await fetch(gateway + "/.well-known/oauth-authorization-server", { signal: AbortSignal.timeout(8000) });
  assert.equal(serverResponse.status, 200);
  const serverMetadata = await serverResponse.json();
  assert.equal(serverMetadata.issuer, publicOrigin);
  assert.equal(serverMetadata.client_id_metadata_document_supported, true);
  assert.equal(serverMetadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(serverMetadata.scopes_supported, OAUTH_SCOPES);
  assert.deepEqual(serverMetadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(serverMetadata.token_endpoint_auth_methods_supported, ["none"]);

  const noAuth = await fetch(gateway + "/mcp/web", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate") || "", /resource_metadata=/);

  const publicAgent = await fetch(gateway + "/mcp/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(publicAgent.status, 404);

  const fullClient = await registerClient([...OAUTH_SCOPES], "full");
  const issued = await authorize(fullClient, [...OAUTH_SCOPES]);
  const diskAfterIssue = await fs.readFile(path.join(runtime.oauthDir, "tokens.json"), "utf8");
  assert.equal(diskAfterIssue.includes(issued.access_token), false);
  assert.equal(diskAfterIssue.includes(issued.refresh_token), false);

  const listed = await rpc("/mcp/web", "tools/list", {}, issued.access_token, 10);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.rpc.result.tools.map((tool) => tool.name), [...VCONTINUITY_WEB_TOOL_NAMES]);

  const health = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.health",
    arguments: { nonce: "v070-oauth" },
  }, issued.access_token, 11);
  assert.equal(health.status, 200);
  assert.equal(health.rpc.result?.structuredContent?.authenticated, true);
  assert.equal(health.rpc.result?.structuredContent?.nonce, "v070-oauth");
  assert.deepEqual(new Set(health.rpc.result.structuredContent.grantedScopes), new Set(OAUTH_SCOPES));
  const fullConnection = health.rpc.result.structuredContent.connectionId;
  assert.ok(fullConnection);

  const exec = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.exec",
    arguments: { command: [process.execPath, "--version"], cwd: runtime.workspaceRoot },
  }, issued.access_token, 12);
  assert.equal(exec.rpc.result?.structuredContent?.exitCode, 0);

  const refreshResponse = await fetch(gateway + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
      client_id: fullClient.client_id,
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token && refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, issued.refresh_token);
  assert.deepEqual(new Set(refreshed.scope.split(/\s+/)), new Set(OAUTH_SCOPES));

  const limitedScopes = ["read", "files:read", "works:read", "git:read"];
  const limitedClient = await registerClient(limitedScopes, "limited");
  const limited = await authorize(limitedClient, limitedScopes);
  const limitedHealth = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.health",
    arguments: { nonce: "limited" },
  }, limited.access_token, 20);
  assert.equal(limitedHealth.rpc.result?.structuredContent?.authenticated, true);
  const limitedConnection = limitedHealth.rpc.result.structuredContent.connectionId;

  const deniedExec = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.exec",
    arguments: { command: [process.execPath, "--version"], cwd: runtime.workspaceRoot },
  }, limited.access_token, 21);
  assert.equal(deniedExec.status, 200);
  assert.equal(deniedExec.rpc.result?.isError, true);
  assert.match(deniedExec.rpc.result?.structuredContent?.error || "", /OAUTH_INSUFFICIENT_SCOPE/);

  const metadataOnly = await registerClient(["read"], "metadata-only");
  const metadataToken = await authorize(metadataOnly, ["read"]);
  const restrictedProject = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.project",
    arguments: { cwd: runtime.workspaceRoot },
  }, metadataToken.access_token, 22);
  assert.deepEqual(restrictedProject.rpc.result?.structuredContent?.continuity, {
    status: "requires_scope", requiredScope: "works:read",
  });
  const metadataHealth = await rpc("/mcp/web", "tools/call", { name: "vcontinuity.health", arguments: {} },
    metadataToken.access_token, 23);
  await revokeConnection(metadataHealth.rpc.result.structuredContent.connectionId);

  const revokeToken = await fetch(gateway + "/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: refreshed.access_token }),
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(revokeToken.status, 200);
  const revoked = await rpc("/mcp/web", "tools/list", {}, refreshed.access_token, 30);
  assert.equal(revoked.status, 401);

  await revokeConnection(fullConnection);
  await revokeConnection(limitedConnection);

  console.log(JSON.stringify({
    ok: true,
    version: "0.7.0",
    webTools: 13,
    scopes: OAUTH_SCOPES,
    dcr: true,
    pkce: "S256",
    tokenExchange: true,
    refreshRotation: true,
    perToolScopes: true,
    bearerRequired: true,
    agentPubliclyHidden: true,
    rawTokensPersisted: false,
    tokenRevocation: true,
    isolated: true,
  }));
} finally {
  await runtime.stop();
}
