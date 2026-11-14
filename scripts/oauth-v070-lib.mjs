import assert from "node:assert/strict";
import crypto from "node:crypto";

export const DEFAULT_REDIRECT_URI = "https://example.com/vcontinuity-oauth-test";

export const s256 = (value) => crypto.createHash("sha256").update(value).digest("base64url");

export function hidden(page, name) {
  const match = new RegExp('name="' + name + '" value="([^"]+)"').exec(page);
  assert.ok(match, "missing hidden input " + name);
  return match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function createOAuthTestClient({
  gateway,
  admin,
  publicOrigin,
  resourcePath = "/mcp/web",
  resource = publicOrigin.replace(/\/$/, "") + resourcePath,
  redirectUri = DEFAULT_REDIRECT_URI,
}) {
  assert.ok(gateway, "gateway URL is required");
  assert.ok(admin, "admin URL is required");
  assert.ok(publicOrigin, "publicOrigin is required");

  async function rpc(pathname, method, params, token, id = 1) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
      authorization: "Bearer " + token,
    };
    if (method === "tools/call") headers["mcp-name"] = params.name;
    const response = await fetch(gateway + pathname, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(12000),
    });
    const raw = await response.text();
    const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
    return {
      status: response.status,
      headers: response.headers,
      rpc: raw ? JSON.parse(line ? line.slice(5).trimStart() : raw) : null,
    };
  }

  async function registerClient(scopes, suffix = "test", customRedirectUri = redirectUri) {
    const response = await fetch(gateway + "/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [customRedirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "vContinuity OAuth verifier " + suffix,
        scope: scopes.join(" "),
      }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 201);
    const client = await response.json();
    assert.ok(client.client_id);
    assert.equal(client.client_secret, undefined);
    return client;
  }

  async function authorize(client, scopes, customRedirectUri = redirectUri) {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const state = crypto.randomBytes(16).toString("hex");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: customRedirectUri,
      scope: scopes.join(" "),
      state,
      resource,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
    });
    const response = await fetch(gateway + "/oauth/authorize?" + query, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /waiting for approval/i);
    const pendingId = /const id="([^"]+)"/.exec(page)?.[1];
    assert.ok(pendingId);

    const adminPage = await (await fetch(admin + "/", { signal: AbortSignal.timeout(8000) })).text();
    const csrf = hidden(adminPage, "csrf");
    const decision = new URLSearchParams({ csrf, id: pendingId, decision: "approve" });
    for (const scope of scopes) decision.append("scope", scope);
    const approved = await fetch(admin + "/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: decision,
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(approved.status, 200);

    const pendingResponse = await fetch(gateway + "/oauth/pending-status?id=" + encodeURIComponent(pendingId), {
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(pendingResponse.status, 200);
    const pending = await pendingResponse.json();
    assert.equal(pending.status, "approved");
    const callback = new URL(pending.redirect);
    assert.equal(callback.searchParams.get("state"), state);
    assert.equal(callback.searchParams.get("iss"), publicOrigin);

    const tokenResponse = await fetch(gateway + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        redirect_uri: customRedirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource,
      }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.ok(tokens.access_token && tokens.refresh_token);
    assert.deepEqual(new Set(tokens.scope.split(/\s+/)), new Set(scopes));
    return tokens;
  }

  async function revokeConnection(connectionId) {
    const page = await (await fetch(admin + "/", { signal: AbortSignal.timeout(8000) })).text();
    const csrf = hidden(page, "csrf");
    const response = await fetch(admin + "/decision", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, decision: "revoke", connectionId }),
      signal: AbortSignal.timeout(8000),
    });
    assert.equal(response.status, 200);
  }

  return {
    gateway,
    admin,
    publicOrigin,
    resource,
    redirectUri,
    rpc,
    registerClient,
    authorize,
    revokeConnection,
  };
}
