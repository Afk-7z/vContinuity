import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { launchTestBrowser } from "../scripts/browser-lib.mjs";
import { startIsolatedRuntime } from "../scripts/isolated-runtime.mjs";
import { s256 } from "../scripts/oauth-v070-lib.mjs";

async function mcpRpc(baseUrl, pathname, method, params = {}, headersExtra = {}, id = 1) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
    ...headersExtra,
  };
  if (method === "tools/call" && params?.name) headers["mcp-name"] = params.name;
  const response = await fetch(baseUrl + pathname, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find((value) => value.startsWith("data:"));
  return {
    status: response.status,
    rpc: raw ? JSON.parse(line ? line.slice(5).trimStart() : raw) : null,
  };
}

async function startLoopbackCallbackServer() {
  const events = [];
  const waiters = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/callback") {
      const entry = {
        href: url.href,
        code: url.searchParams.get("code"),
        error: url.searchParams.get("error"),
        state: url.searchParams.get("state"),
        iss: url.searchParams.get("iss"),
      };
      events.push(entry);
      while (waiters.length) {
        const resolve = waiters.shift();
        resolve(entry);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><html><body><h1 id="cb-ok">OAuth Callback Received</h1></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = "http://127.0.0.1:" + server.address().port + "/callback";
  return {
    redirectUri,
    waitForState(expectedState, timeoutMs = 15000) {
      const existing = events.find((e) => e.state === expectedState);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for OAuth callback state=" + expectedState)), timeoutMs);
        const check = (entry) => {
          if (entry.state === expectedState) {
            clearTimeout(timer);
            resolve(entry);
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      });
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function assertNoSecretsInLogs(logs, secrets = []) {
  assert.doesNotMatch(logs, /\bcw_(?:at|rt|code)_[A-Za-z0-9_-]{8,}\b/);
  assert.doesNotMatch(logs, /\bcsrf_[A-Za-z0-9_-]{8,}\b/);
  assert.doesNotMatch(logs, /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i);
  for (const s of secrets) {
    if (s) assert.equal(logs.includes(s), false, "Secret leaked in runtime stdout/stderr");
  }
}

test("browser: work creation, draft preservation, checkpoint save, and continuity resume", async () => {
  const runtime = await startIsolatedRuntime({ prefix: "vcontinuity-pw-work-" });
  const { browser } = await launchTestBrowser();
  const pageErrors = [];

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(runtime.adminUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#csrf-token", { state: "attached" });
    await page.waitForSelector("#project-quick-roots .quick-root-btn");
    const csrf = await page.inputValue("#csrf-token");
    assert.ok(csrf.startsWith("csrf_"));

    const created = await page.evaluate(async ({ token, workRoot }) => {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({
          action: "work_create",
          root: workRoot,
          title: "Projeto E2E Browser",
          goal: "Validar rascunho, checkpoint e retomada no painel",
        }),
      });
      return { status: res.status, body: await res.json() };
    }, { token: csrf, workRoot: runtime.workspaceRoot });

    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.ok, true);
    const workId = created.body.work?.workId || created.body.workId;
    assert.ok(workId, "work_create should return workId");

    await page.click("#refresh-now");
    const itemSelector = '#works-list .list-item[data-work-id="' + workId + '"]';
    await page.waitForSelector(itemSelector);
    await page.click(itemSelector);
    await page.waitForSelector("#work-update-card:not([hidden])");

    const draftSummary = "Rascunho em andamento: checkpoint browser " + crypto.randomBytes(3).toString("hex");
    const draftNext = "Passo 1: validar persistencia\nPasso 2: retomar no MCP";
    await page.fill("#wf-summary", draftSummary);
    await page.fill("#wf-next", draftNext);

    // Switch tabs and trigger refresh to ensure draft survives polling/navigation before save.
    await page.click('.tab-btn[data-tab="system"]');
    await page.waitForSelector("#tab-system.active");
    await page.click("#refresh-now");
    await page.waitForTimeout(400);
    await page.click('.tab-btn[data-tab="works"]');
    await page.waitForSelector("#tab-works.active");

    assert.equal(await page.inputValue("#wf-summary"), draftSummary);
    assert.equal(await page.inputValue("#wf-next"), draftNext);

    const ckptReqPromise = page.waitForRequest((req) =>
      req.url().endsWith("/api/action") && req.method() === "POST",
    );
    await page.click("#btn-save-checkpoint");
    const ckptReq = await ckptReqPromise;
    const ckptPayload = JSON.parse(ckptReq.postData() || "{}");
    assert.equal(ckptPayload.action, "work_checkpoint");
    assert.equal(ckptPayload.expectedRevision, 1);

    await page.waitForFunction(() => {
      const banner = document.getElementById("banner");
      const text = document.getElementById("banner-text")?.textContent || "";
      return banner && !banner.hidden && /checkpoint/i.test(text);
    });
    assert.match(await page.textContent("#banner-text"), /checkpoint/i);

    await page.waitForFunction((expected) => {
      const doc = document.getElementById("work-doc-viewer")?.textContent || "";
      return doc.includes(expected);
    }, draftSummary);

    // Simulate concurrent edit leading to HTTP 409 WORK_REVISION_CONFLICT and recovery via rebase.
    const localDraftBeforeConflict = "Rascunho local concorrente " + crypto.randomBytes(3).toString("hex");
    await page.fill("#wf-summary", localDraftBeforeConflict);
    const remoteMcpUpdate = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: {
        action: "checkpoint",
        workId,
        expectedRevision: 2,
        summary: "Atualizacao remota concorrente rev3",
        client: "concurrent-mcp-client",
      },
    }, {}, 10);
    assert.equal(remoteMcpUpdate.status, 200);
    assert.equal(remoteMcpUpdate.rpc.result?.structuredContent?.ok, true);

    await page.waitForSelector("#work-server-update-notice:not([hidden])", { timeout: 6000 });
    assert.equal(await page.inputValue("#wf-summary"), localDraftBeforeConflict);

    const conflictResPromise = page.waitForResponse((res) =>
      res.url().endsWith("/api/action") && res.request().method() === "POST",
    );
    await page.click("#btn-save-checkpoint");
    const conflictRes = await conflictResPromise;
    assert.equal(conflictRes.status(), 409);
    const conflictJson = await conflictRes.json();
    assert.equal(conflictJson.code, "WORK_REVISION_CONFLICT");
    assert.equal(conflictJson.currentRevision, 3);

    await page.waitForSelector("#work-conflict-box:not([hidden])");
    assert.equal(await page.inputValue("#wf-summary"), localDraftBeforeConflict);

    await page.click("#btn-conflict-rebase");
    await page.waitForSelector("#work-conflict-box", { state: "hidden" });
    assert.equal(await page.inputValue("#wf-summary"), localDraftBeforeConflict);

    const rebasedReqPromise = page.waitForRequest((req) =>
      req.url().endsWith("/api/action") && req.method() === "POST",
    );
    await page.click("#btn-save-checkpoint");
    const rebasedReq = await rebasedReqPromise;
    const rebasedPayload = JSON.parse(rebasedReq.postData() || "{}");
    assert.equal(rebasedPayload.expectedRevision, 3);

    await page.waitForFunction((expected) => {
      const doc = document.getElementById("work-doc-viewer")?.textContent || "";
      return doc.includes(expected);
    }, localDraftBeforeConflict);

    // Reload browser page and verify persisted state + activation/resume.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(itemSelector);
    await page.click(itemSelector);
    await page.waitForFunction((expected) => {
      const doc = document.getElementById("work-doc-viewer")?.textContent || "";
      return doc.includes(expected);
    }, localDraftBeforeConflict);
    assert.equal(await page.inputValue("#wf-summary"), localDraftBeforeConflict);

    await page.click("#btn-activate-web");
    await page.waitForFunction(() => {
      const text = document.getElementById("banner-text")?.textContent || "";
      return /web/i.test(text);
    });

    const resumed = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "resume", workId, client: "browser-e2e" },
    });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.rpc.result?.structuredContent?.ok, true);
    assert.ok(resumed.rpc.result?.structuredContent?.context?.includes(localDraftBeforeConflict));

    const listedByRoot = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "list", root: runtime.workspaceRoot },
    }, {}, 2);
    assert.equal(listedByRoot.status, 200);
    assert.ok(listedByRoot.rpc.result?.structuredContent?.works?.some((w) => w.workId === workId));

    const projectInfo = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.project",
      arguments: { cwd: runtime.workspaceRoot },
    }, {}, 3);
    assert.equal(projectInfo.status, 200);
    assert.ok(projectInfo.rpc.result?.structuredContent?.continuity?.status);
    assert.ok(Array.isArray(projectInfo.rpc.result?.structuredContent?.continuity?.works));
    assert.ok(projectInfo.rpc.result?.structuredContent?.continuity?.works.some((w) => w.workId === workId));

    assert.deepEqual(pageErrors, []);
    assertNoSecretsInLogs(runtime.getLogs(), [csrf]);
  } finally {
    await browser.close().catch(() => {});
    await runtime.stop();
  }
});

test("browser: OAuth scope selection, PKCE callback, multi-connection isolation, deny, and revoke", async () => {
  const callbackSrv = await startLoopbackCallbackServer();
  const runtime = await startIsolatedRuntime({ prefix: "vcontinuity-pw-oauth-" });
  const { browser } = await launchTestBrowser();
  const pageErrors = [];

  try {
    const register = async (name) => {
      const res = await fetch(runtime.gatewayUrl + "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [callbackSrv.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: name,
          scope: "read files:read files:write commands:run works:read works:write git:read git:write",
        }),
      });
      assert.equal(res.status, 201);
      return await res.json();
    };

    const clientA = await register("Browser Client Alpha");
    const clientB = await register("Browser Client Beta");

    const context = await browser.newContext();
    const adminPage = await context.newPage();
    adminPage.on("pageerror", (err) => pageErrors.push(err.message));
    await adminPage.goto(runtime.adminUrl + "/", { waitUntil: "domcontentloaded" });
    await adminPage.waitForSelector("#csrf-token", { state: "attached" });

    // Flow 1: Authorize Client Alpha with partial scope selection in the real dashboard UI.
    const verifierA = crypto.randomBytes(48).toString("base64url");
    const stateA = crypto.randomBytes(16).toString("hex");
    const authUrlA = runtime.gatewayUrl + "/oauth/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: clientA.client_id,
      redirect_uri: callbackSrv.redirectUri,
      scope: "read files:read files:write commands:run works:read works:write git:read git:write",
      state: stateA,
      resource: runtime.resourceUrl,
      code_challenge: s256(verifierA),
      code_challenge_method: "S256",
    });

    const authPageA = await context.newPage();
    authPageA.on("pageerror", (err) => pageErrors.push(err.message));
    await authPageA.goto(authUrlA, { waitUntil: "domcontentloaded" });
    await authPageA.waitForFunction(() => /Waiting for local approval/i.test(document.body.innerText));

    await adminPage.click("#refresh-now");
    await adminPage.waitForSelector("#pending-oauth-box:not([hidden]) input[name=scope]");
    for (const scopeToUncheck of ["commands:run", "files:write", "git:write"]) {
      const checkbox = adminPage.locator('#pending-oauth-list input[name=scope][value="' + scopeToUncheck + '"]');
      if (await checkbox.isChecked()) await checkbox.uncheck();
    }
    // Wait more than one full 2s auto-refresh polling cycle to confirm unchecked scopes remain unchecked.
    assert.equal(await adminPage.isChecked("#auto-refresh"), true);
    await adminPage.waitForTimeout(2400);
    for (const scopeToUncheck of ["commands:run", "files:write", "git:write"]) {
      const checkbox = adminPage.locator('#pending-oauth-list input[name=scope][value="' + scopeToUncheck + '"]');
      assert.equal(await checkbox.isChecked(), false, "Scope " + scopeToUncheck + " reset by polling");
    }
    assert.equal(await adminPage.locator('#pending-oauth-list input[name=scope][value="read"]').isChecked(), true);

    await adminPage.click('#pending-oauth-list button[name="decision"][value="approve"]');
    await adminPage.waitForFunction(() => {
      const banner = document.getElementById("banner");
      return banner && !banner.hidden && /aprovado/i.test(document.getElementById("banner-text")?.textContent || "");
    });

    const cbA = await callbackSrv.waitForState(stateA);
    assert.ok(cbA.code);
    assert.equal(cbA.iss, runtime.publicOrigin);
    await authPageA.waitForSelector("#cb-ok");
    await authPageA.close();

    const tokenResA = await fetch(runtime.gatewayUrl + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: cbA.code,
        redirect_uri: callbackSrv.redirectUri,
        client_id: clientA.client_id,
        code_verifier: verifierA,
        resource: runtime.resourceUrl,
      }),
    });
    assert.equal(tokenResA.status, 200);
    const tokensA = await tokenResA.json();
    assert.deepEqual(
      new Set(tokensA.scope.split(/\s+/)),
      new Set(["read", "files:read", "works:read", "works:write", "git:read"]),
    );

    const healthA = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.health",
      arguments: { nonce: "browser-alpha" },
    }, { authorization: "Bearer " + tokensA.access_token }, 10);
    assert.equal(healthA.status, 200);
    assert.equal(healthA.rpc.result?.structuredContent?.authenticated, true);
    const connectionIdA = healthA.rpc.result?.structuredContent?.connectionId;
    assert.ok(connectionIdA);

    const deniedExecA = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.exec",
      arguments: { command: [process.execPath, "--version"], cwd: runtime.workspaceRoot },
    }, { authorization: "Bearer " + tokensA.access_token }, 11);
    assert.equal(deniedExecA.status, 200);
    assert.equal(deniedExecA.rpc.result?.isError, true);
    assert.match(deniedExecA.rpc.result?.structuredContent?.error || "", /OAUTH_INSUFFICIENT_SCOPE/);

    // Flow 2: Authorize Client Beta with all scopes -> verify two independent connections in OAuth tab.
    const verifierB = crypto.randomBytes(48).toString("base64url");
    const stateB = crypto.randomBytes(16).toString("hex");
    const authPageB = await context.newPage();
    await authPageB.goto(runtime.gatewayUrl + "/oauth/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: clientB.client_id,
      redirect_uri: callbackSrv.redirectUri,
      scope: "read files:read files:write commands:run works:read works:write git:read git:write",
      state: stateB,
      resource: runtime.resourceUrl,
      code_challenge: s256(verifierB),
      code_challenge_method: "S256",
    }), { waitUntil: "domcontentloaded" });

    await adminPage.click("#refresh-now");
    await adminPage.waitForSelector("#pending-oauth-box:not([hidden]) button[name='decision'][value='approve']");
    await adminPage.click('#pending-oauth-list button[name="decision"][value="approve"]');
    const cbB = await callbackSrv.waitForState(stateB);
    assert.ok(cbB.code);
    await authPageB.waitForSelector("#cb-ok");
    await authPageB.close();

    const tokenResB = await fetch(runtime.gatewayUrl + "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: cbB.code,
        redirect_uri: callbackSrv.redirectUri,
        client_id: clientB.client_id,
        code_verifier: verifierB,
        resource: runtime.resourceUrl,
      }),
    });
    assert.equal(tokenResB.status, 200);
    const tokensB = await tokenResB.json();

    const healthB = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.health",
      arguments: { nonce: "browser-beta" },
    }, { authorization: "Bearer " + tokensB.access_token }, 12);
    const connectionIdB = healthB.rpc.result?.structuredContent?.connectionId;
    assert.ok(connectionIdB);
    assert.notEqual(connectionIdA, connectionIdB);

    // Verify independent per-connection Work Context activations and journals.
    const workAlpha = "conn-alpha-" + crypto.randomBytes(3).toString("hex");
    const workBeta = "conn-beta-" + crypto.randomBytes(3).toString("hex");
    const createA = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "create", workId: workAlpha, title: "Alpha Work", goal: "Isolate Alpha" },
    }, { authorization: "Bearer " + tokensA.access_token }, 20);
    assert.equal(createA.status, 200);
    assert.equal(createA.rpc.result?.structuredContent?.ok, true);

    const createB = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "create", workId: workBeta, title: "Beta Work", goal: "Isolate Beta" },
    }, { authorization: "Bearer " + tokensB.access_token }, 21);
    assert.equal(createB.status, 200);
    assert.equal(createB.rpc.result?.structuredContent?.ok, true);

    await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.fs_read",
      arguments: { paths: [runtime.configPath] },
    }, { authorization: "Bearer " + tokensA.access_token }, 22);

    const statusA = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "status" },
    }, { authorization: "Bearer " + tokensA.access_token }, 23);
    const statusB = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "status" },
    }, { authorization: "Bearer " + tokensB.access_token }, 24);
    assert.equal(statusA.rpc.result?.structuredContent?.active?.workId, workAlpha);
    assert.equal(statusB.rpc.result?.structuredContent?.active?.workId, workBeta);

    const histB = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.work",
      arguments: { action: "history", workId: workBeta },
    }, { authorization: "Bearer " + tokensB.access_token }, 25);
    assert.equal((histB.rpc.result?.structuredContent?.events || []).some((e) => e.tool === "vcontinuity.fs_read"), false);

    // Switch to OAuth tab and revoke ONLY Alpha; Beta must stay active.
    await adminPage.click('.tab-btn[data-tab="oauth"]');
    await adminPage.waitForSelector("#tab-oauth.active");
    await adminPage.waitForFunction(([idA, idB]) => {
      const html = document.getElementById("oauth-grants-container")?.innerHTML || "";
      return html.includes(idA) && html.includes(idB);
    }, [connectionIdA, connectionIdB]);

    const revokeAlphaBtn = adminPage.locator(
      '#oauth-grants-container tr:has-text("' + connectionIdA + '") button[name="decision"][value="revoke"]',
    );
    await revokeAlphaBtn.click();
    await adminPage.waitForSelector("#confirm-modal:not([hidden])");
    await adminPage.click("#confirm-modal-ok");
    await adminPage.waitForFunction(() => {
      return /revogada/i.test(document.getElementById("banner-text")?.textContent || "");
    });

    const afterRevokeA = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/list", {}, {
      authorization: "Bearer " + tokensA.access_token,
    }, 13);
    assert.equal(afterRevokeA.status, 401);

    const stillValidB = await mcpRpc(runtime.gatewayUrl, "/mcp/web", "tools/list", {}, {
      authorization: "Bearer " + tokensB.access_token,
    }, 14);
    assert.equal(stillValidB.status, 200);

    // Flow 3: Deny a pending request in the browser UI.
    const verifierC = crypto.randomBytes(48).toString("base64url");
    const stateC = crypto.randomBytes(16).toString("hex");
    const authPageC = await context.newPage();
    await authPageC.goto(runtime.gatewayUrl + "/oauth/authorize?" + new URLSearchParams({
      response_type: "code",
      client_id: clientB.client_id,
      redirect_uri: callbackSrv.redirectUri,
      scope: "read",
      state: stateC,
      resource: runtime.resourceUrl,
      code_challenge: s256(verifierC),
      code_challenge_method: "S256",
    }), { waitUntil: "domcontentloaded" });

    await adminPage.click("#refresh-now");
    await adminPage.waitForSelector("#pending-oauth-box:not([hidden]) button[name='decision'][value='deny']");
    await adminPage.click('#pending-oauth-list button[name="decision"][value="deny"]');
    await adminPage.waitForFunction(() => {
      return /negada/i.test(document.getElementById("banner-text")?.textContent || "");
    });

    const cbC = await callbackSrv.waitForState(stateC);
    assert.equal(cbC.error, "access_denied");
    assert.equal(cbC.iss, runtime.publicOrigin);
    await authPageC.waitForSelector("#cb-ok");
    await authPageC.close();

    assert.deepEqual(pageErrors, []);
    assertNoSecretsInLogs(runtime.getLogs(), [
      tokensA.access_token,
      tokensA.refresh_token,
      tokensB.access_token,
      tokensB.refresh_token,
    ]);
  } finally {
    await browser.close().catch(() => {});
    await callbackSrv.close();
    await runtime.stop();
  }
});

test("browser: multi-work independent drafts across tabs, checkpoint compare/history, and job prune/restore", async () => {
  const runtime = await startIsolatedRuntime({ prefix: "vcontinuity-pw-reg-" });
  const { browser } = await launchTestBrowser();
  const pageErrors = [];

  try {
    const projA = path.join(runtime.workspaceRoot, "proj-alpha");
    const projB = path.join(runtime.workspaceRoot, "proj-beta");
    await Promise.all([
      fs.mkdir(projA, { recursive: true }),
      fs.mkdir(projB, { recursive: true }),
    ]);

    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(runtime.adminUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#csrf-token", { state: "attached" });
    await page.waitForSelector("#project-quick-roots .quick-root-btn");
    const csrf = await page.inputValue("#csrf-token");

    // Register Project A through the discovery UI flow.
    await page.fill("#project-cwd-input", projA);
    await page.click("#btn-discover-project");
    await page.waitForSelector("#btn-create-work");
    await page.fill("#create-work-title", "Projeto Alpha");
    await page.fill("#create-work-goal", "Draft A e compare");
    await page.click("#btn-create-work");
    await page.waitForFunction(() => /registrado com sucesso/i.test(document.getElementById("banner-text")?.textContent || ""));

    // Register Project B via POST /api/action work_create.
    const createdB = await page.evaluate(async ({ token, workRoot }) => {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": token,
        },
        body: JSON.stringify({
          action: "work_create",
          root: workRoot,
          title: "Projeto Beta",
          goal: "Draft B independente",
        }),
      });
      return { status: res.status, body: await res.json() };
    }, { token: csrf, workRoot: projB });
    assert.equal(createdB.status, 200);
    const workIdB = createdB.body.work?.workId;
    assert.ok(workIdB);

    await page.click("#refresh-now");
    const workIdA = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#works-list .list-item[data-work-id]")];
      const alpha = items.find((el) => el.textContent.includes("Projeto Alpha"));
      return alpha ? alpha.getAttribute("data-work-id") : null;
    });
    assert.ok(workIdA);
    assert.notEqual(workIdA, workIdB);

    const selA = '#works-list .list-item[data-work-id="' + workIdA + '"]';
    const selB = '#works-list .list-item[data-work-id="' + workIdB + '"]';
    await page.waitForSelector(selA);
    await page.waitForSelector(selB);

    // Enter Draft A, switch to Work B, enter Draft B.
    const draftASummary = "Draft Alpha v1 " + crypto.randomBytes(3).toString("hex");
    const draftANext = "A-step-1\nA-step-2";
    await page.click(selA);
    await page.waitForFunction((id) => (document.getElementById("work-detail-title")?.textContent || "").includes(id), workIdA);
    await page.fill("#wf-summary", draftASummary);
    await page.fill("#wf-next", draftANext);
    await page.waitForFunction(() => /Rascunho/i.test(document.getElementById("work-draft-badge")?.textContent || ""));

    const draftBSummary = "Draft Beta v1 " + crypto.randomBytes(3).toString("hex");
    const draftBNext = "B-step-1";
    await page.click(selB);
    await page.waitForFunction((id) => (document.getElementById("work-detail-title")?.textContent || "").includes(id), workIdB);
    await page.fill("#wf-summary", draftBSummary);
    await page.fill("#wf-next", draftBNext);

    // Switch to another tab and wait a full 2s polling cycle, then return to Works.
    await page.click('.tab-btn[data-tab="system"]');
    await page.waitForSelector("#tab-system.active");
    await page.waitForTimeout(2300);
    await page.click('.tab-btn[data-tab="works"]');
    await page.waitForSelector("#tab-works.active");

    assert.equal(await page.inputValue("#wf-summary"), draftBSummary);
    assert.equal(await page.inputValue("#wf-next"), draftBNext);

    // Switch back to Work A and verify Draft A remained intact independently.
    await page.click(selA);
    await page.waitForFunction((id) => (document.getElementById("work-detail-title")?.textContent || "").includes(id), workIdA);
    assert.equal(await page.inputValue("#wf-summary"), draftASummary);
    assert.equal(await page.inputValue("#wf-next"), draftANext);

    // Save two checkpoints on Work A to test checkpoint diff compare and history search.
    await page.click("#btn-save-checkpoint");
    await page.waitForFunction((expected) => (document.getElementById("work-doc-viewer")?.textContent || "").includes(expected), draftASummary);

    const draftASummaryV2 = "Draft Alpha v2 " + crypto.randomBytes(3).toString("hex");
    await page.fill("#wf-summary", draftASummaryV2);
    await page.click("#btn-save-checkpoint");
    await page.waitForFunction((expected) => (document.getElementById("work-doc-viewer")?.textContent || "").includes(expected), draftASummaryV2);

    await page.click('.subtab-btn[data-doc="checkpoints"]');
    await page.waitForSelector("#work-checkpoints-panel:not([hidden])");
    await page.selectOption("#ckpt-left-select", "1");
    await page.selectOption("#ckpt-right-select", "2");
    await page.check("#ckpt-diff-only");
    await page.waitForFunction(([v1, v2]) => {
      const left = document.getElementById("ckpt-left-content")?.textContent || "";
      const right = document.getElementById("ckpt-right-content")?.textContent || "";
      return left.includes(v1) && right.includes(v2);
    }, [draftASummary, draftASummaryV2]);
    assert.ok((await page.locator("#ckpt-right-content .diff-line-add").count()) > 0);

    await page.click('.subtab-btn[data-doc="events"]');
    await page.waitForSelector("#work-history-panel:not([hidden])");
    await page.selectOption("#history-category-filter", "events");
    await page.fill("#history-search-input", "checkpoint");
    await page.waitForFunction(() => /checkpoint/i.test(document.getElementById("history-results-list")?.textContent || ""));

    // Run a short isolated job, then test job prune preview + persistent restore in the Jobs tab.
    const started = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.job",
      arguments: {
        action: "start",
        title: "browser-prune-restore",
        command: [process.execPath, "-e", "console.log('JOB_PRUNE_OK')"],
        cwd: projB,
        timeoutMs: 5000,
      },
    }, {}, 30);
    assert.equal(started.status, 200);
    const jobId = started.rpc.result?.structuredContent?.jobId;
    assert.match(jobId || "", /^job_/);

    const waited = await mcpRpc(runtime.mcpUrl, "/mcp/web", "tools/call", {
      name: "vcontinuity.job",
      arguments: { action: "wait", jobId, timeoutMs: 5000 },
    }, {}, 31);
    assert.equal(waited.rpc.result?.structuredContent?.snapshots?.[0]?.status, "completed");

    await page.click('.tab-btn[data-tab="jobs"]');
    await page.waitForSelector("#tab-jobs.active");
    await page.click("#refresh-now");
    const jobSel = '#jobs-list .list-item[data-job-id="' + jobId + '"]';
    await page.waitForSelector(jobSel);

    await page.click("#btn-prune-jobs");
    await page.waitForSelector("#confirm-modal:not([hidden])");
    await page.waitForFunction(() => (document.getElementById("confirm-modal-items")?.textContent || "").includes("browser-prune-restore"));
    await page.click("#confirm-modal-ok");
    await page.waitForSelector("#jobs-archive-bar:not([hidden])");
    await page.waitForSelector(jobSel, { state: "detached" });

    await page.click("#btn-restore-jobs");
    await page.waitForSelector("#confirm-modal:not([hidden])");
    await page.click("#confirm-modal-ok");
    await page.waitForSelector(jobSel);

    // Reload page and confirm restored job persisted on disk.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.click('.tab-btn[data-tab="jobs"]');
    await page.waitForSelector(jobSel);

    assert.deepEqual(pageErrors, []);
    assertNoSecretsInLogs(runtime.getLogs(), [csrf]);
  } finally {
    await browser.close().catch(() => {});
    await runtime.stop();
  }
});
