import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { OAUTH_SCOPES } from "../src/vcontinuity/oauth.mjs";
import { startIsolatedRuntime } from "./isolated-runtime.mjs";
import { createOAuthTestClient } from "./oauth-v070-lib.mjs";

const allowed = new Set(OAUTH_SCOPES);
const retired = new Set(["browser:read", "browser:write", "agent:run"]);
const stableClientId = "https://chatgpt.com/oauth/client.json";
const fixtureConnectionId = "conn_" + crypto.randomBytes(9).toString("hex");

const runtime = await startIsolatedRuntime({
  prefix: "vcontinuity-oauth-sec-",
  async beforeLaunch(iso) {
    const now = new Date().toISOString();
    const resourceUrl = iso.publicOrigin.replace(/\/$/, "") + iso.resourcePath;
    await fs.writeFile(path.join(iso.oauthDir, "clients.json"), JSON.stringify({
      schema: 1,
      clients: [
        {
          clientId: stableClientId,
          source: "cimd",
          metadata: {
            client_id: stableClientId,
            redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            application_type: "web",
            client_name: "ChatGPT Fixture",
            scope: OAUTH_SCOPES.join(" "),
          },
          createdAt: now,
          updatedAt: now,
        },
      ],
    }, null, 2) + "\n", "utf8");

    await fs.writeFile(path.join(iso.oauthDir, "grants.json"), JSON.stringify({
      schema: 1,
      grants: [
        {
          connectionId: fixtureConnectionId,
          clientId: stableClientId,
          clientName: "ChatGPT Fixture",
          scopes: [...OAUTH_SCOPES],
          resource: resourceUrl,
          createdAt: now,
          updatedAt: now,
          revokedAt: null,
        },
      ],
    }, null, 2) + "\n", "utf8");
  },
});

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
  assert.deepEqual(protectedMetadata.scopes_supported, OAUTH_SCOPES);

  const serverResponse = await fetch(gateway + "/.well-known/oauth-authorization-server", { signal: AbortSignal.timeout(8000) });
  assert.equal(serverResponse.status, 200);
  const metadata = await serverResponse.json();
  assert.equal(metadata.issuer, publicOrigin);
  assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal(metadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(metadata.scopes_supported, OAUTH_SCOPES);
  assert.equal(metadata.scopes_supported.some((scope) => retired.has(scope)), false);

  const noAuth = await fetch(gateway + "/mcp/web", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(noAuth.status, 401);

  const publicAgent = await fetch(gateway + "/mcp/agent", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(publicAgent.status, 404);

  const tempClient = await registerClient([...OAUTH_SCOPES], "sec-check");
  const issued = await authorize(tempClient, [...OAUTH_SCOPES]);
  const health = await rpc("/mcp/web", "tools/call", {
    name: "vcontinuity.health",
    arguments: { nonce: "sec" },
  }, issued.access_token, 1);
  assert.equal(health.status, 200);
  const tempConnectionId = health.rpc.result?.structuredContent?.connectionId;
  assert.ok(tempConnectionId);
  assert.notEqual(tempConnectionId, fixtureConnectionId);

  const grants = JSON.parse(await fs.readFile(path.join(runtime.oauthDir, "grants.json"), "utf8"));
  const tokens = JSON.parse(await fs.readFile(path.join(runtime.oauthDir, "tokens.json"), "utf8"));
  const clients = JSON.parse(await fs.readFile(path.join(runtime.oauthDir, "clients.json"), "utf8"));

  for (const grant of grants.grants || []) {
    for (const scope of grant.scopes || []) assert.ok(allowed.has(scope), "retired/unknown scope in grant: " + scope);
  }
  assert.ok((tokens.tokens || []).length >= 2);
  for (const token of tokens.tokens || []) {
    for (const scope of token.scopes || []) assert.ok(allowed.has(scope), "retired/unknown scope in token: " + scope);
    assert.equal(Object.hasOwn(token, "token"), false);
    assert.equal(Object.hasOwn(token, "access_token"), false);
    assert.equal(Object.hasOwn(token, "refresh_token"), false);
    assert.match(token.tokenHash || "", /^[a-f0-9]{64}$/);
  }
  for (const client of clients.clients || []) {
    const scopes = String(client.metadata?.scope || "").split(/\s+/).filter(Boolean);
    for (const scope of scopes) assert.ok(allowed.has(scope), "retired/unknown scope in client metadata: " + scope);
  }

  const activeStable = (grants.grants || []).filter((grant) =>
    !grant.revokedAt && grant.clientId === stableClientId,
  );
  assert.equal(activeStable.length, 1);
  assert.deepEqual(new Set(activeStable[0].scopes), new Set(OAUTH_SCOPES));

  await revokeConnection(tempConnectionId);
  const afterRevoke = await rpc("/mcp/web", "tools/list", {}, issued.access_token, 2);
  assert.equal(afterRevoke.status, 401);

  console.log(JSON.stringify({
    ok: true,
    scopes: OAUTH_SCOPES,
    retiredScopesAbsent: true,
    rawTokensPersisted: false,
    activeStableChatGPTGrant: true,
    agentPubliclyHidden: true,
    cimdAdvertised: true,
    isolated: true,
  }));
} finally {
  await runtime.stop();
}
