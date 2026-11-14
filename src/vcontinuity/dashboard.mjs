import fs from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { config, safePath } from "./filesystem.mjs";
import { manageJob, previewJobPrune, pruneJobs, restoreJobs } from "./job-manager.mjs";
import { workContextService, workContextOp } from "./work-context.mjs";
import { fileTransferService } from "./file-transfer-service.mjs";
import { VCONTINUITY_VERSION } from "./version.mjs";
import { VCONTINUITY_WEB_TOOL_NAMES } from "./web.mjs";

const templateHtml = readFileSync(new URL("./dashboard-ui.html", import.meta.url), "utf8");
const startedAtMs = Date.now();
const MAX_BODY = 256 * 1024;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PRUNE_LABELS = {
  "Revoked OAuth grant": "Concessão OAuth revogada",
  "Expired or revoked refresh token": "Token de renovação expirado ou revogado",
  "Expired or revoked access token": "Token de acesso expirado ou revogado",
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

async function readBody(req, max = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "pragma": "no-cache",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  res.end(html);
}

async function listRecentFiles(dir, limit = 15) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const st = await fs.stat(fullPath);
        files.push({
          name: entry.name,
          path: fullPath,
          bytes: st.size,
          updatedAt: new Date(st.mtimeMs).toISOString(),
          mtimeMs: st.mtimeMs,
        });
      } catch {}
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, limit);
  } catch {
    return [];
  }
}

async function collectWorksOverview(grants) {
  const [listed, activeWeb, activeAgent] = await Promise.all([
    workContextService.list({ limit: 50 }),
    workContextService.getActive("web"),
    workContextService.getActive("agent"),
  ]);
  const [detailed, activeWebConnections] = await Promise.all([
    Promise.all(listed.works.map(async (work) => {
      try {
        const { work: current, state, guidance } = await workContextService.inspect(work.workId);
        return { ...current, state, guidance };
      } catch {
        return { ...work, state: null };
      }
    })),
    Promise.all(grants.filter((grant) => grant.scopes.includes("works:read")).map(async (grant) => ({
      connectionId: grant.connectionId,
      clientName: grant.clientName,
      active: await workContextService.getActive("web", "oauth:" + grant.connectionId),
    }))),
  ]);
  return {
    root: listed.root,
    count: listed.count,
    activeWeb,
    activeAgent,
    activeWebConnections,
    works: detailed,
  };
}

async function collectTransfersOverview() {
  const wf = await fileTransferService.workflow();
  const [importsList, exportsList] = await Promise.all([
    listRecentFiles(wf.imports, 15),
    listRecentFiles(wf.exports, 15),
  ]);
  let recentReceipts = [];
  try {
    const stateEntries = await fs.readdir(fileTransferService.stateDir, { withFileTypes: true });
    const jsonFiles = stateEntries.filter((e) => e.isFile() && e.name.endsWith(".json")).slice(0, 30);
    const parsed = await Promise.all(
      jsonFiles.map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(fileTransferService.stateDir, entry.name), "utf8");
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }),
    );
    recentReceipts = parsed
      .filter(Boolean)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 15);
  } catch {}

  const now = Date.now();
  const activeDeliveries = [];
  for (const [, grant] of fileTransferService.grants.entries()) {
    if (grant.expires > now) {
      activeDeliveries.push({
        filename: grant.filename,
        bytes: grant.bytes,
        sha256: grant.sha256,
        expiresAt: new Date(grant.expires).toISOString(),
      });
    }
  }

  return {
    root: wf.root,
    importsDir: wf.imports,
    exportsDir: wf.exports,
    maxInputBytes: wf.max_input_bytes,
    tunnelActive: Boolean(fileTransferService.publicUrl),
    tunnelUrl: fileTransferService.publicUrl || null,
    activeImportsCount: fileTransferService.running.size,
    activeDeliveries,
    imports: importsList,
    exports: exportsList,
    recentReceipts,
  };
}

export function createDashboardHandler({ oauth, ports, getDeepHealth }) {
  const previews = new Map();
  async function renderDashboardPage(res, bannerMessage = "", status = 200) {
    const html = templateHtml
      .replace(/__CSRF_TOKEN__/g, () => esc(oauth.adminCsrf))
      .replace(/__BANNER_MESSAGE__/g, () => esc(bannerMessage));
    sendHtml(res, status, html);
  }

  async function runCleanup(action, payload) {
    for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id);
    const jobs = action === "job_prune";
    if (payload.previewOnly === true) {
      const preview = await (jobs ? previewJobPrune() : oauth.previewOAuthPrune());
      const previewId = randomBytes(24).toString("base64url");
      if (previews.size >= 32) previews.delete(previews.keys().next().value);
      previews.set(previewId, {
        action, expires: Date.now() + PREVIEW_TTL_MS,
        candidates: preview.candidates,
        jobIds: jobs ? preview.items.map(({ jobId }) => jobId) : undefined,
      });
      const items = jobs ? preview.items : preview.items.map((item) => ({
        ...item, label: PRUNE_LABELS[item.label] ?? item.label,
      }));
      return { ok: true, previewId, items, count: preview.count };
    }
    const preview = previews.get(payload.previewId);
    if (!preview || preview.action !== action) throw new Error("A prévia expirou ou não é válida. Gere outra prévia.");
    previews.delete(payload.previewId);
    if (jobs) return pruneJobs({ jobIds: preview.jobIds, candidates: preview.candidates });
    const result = await oauth.pruneOAuthState({ candidates: preview.candidates });
    if (!result.ok) {
      result.error = "A limpeza OAuth não foi concluída. Confira os registros restantes e gere outra prévia.";
    }
    return result;
  }

  function errorReply(res, error) {
    if (error.code === "WORK_REVISION_CONFLICT") {
      return sendJson(res, 409, {
        ok: false, code: error.code, currentRevision: error.currentRevision,
        error: "Este trabalho mudou desde que você começou a editar. Revise a versão atual antes de salvar.",
      });
    }
    if (error.message.startsWith("WORK_ALREADY_EXISTS:")) {
      return sendJson(res, 409, { ok: false, error: "Este projeto já tem um registro. Consulte a pasta novamente." });
    }
    sendJson(res, error.code === "ENOENT" ? 404 : 400, { ok: false, error: error.message });
  }

  function workEdits(payload) {
    const { expectedRevision, summary, phase } = payload;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Abra a versão atual do trabalho antes de salvar.");
    const edits = { expectedRevision };
    if (typeof phase === "string") edits.phase = phase;
    if (typeof summary === "string") edits.summary = summary;
    for (const field of ["nextSteps", "tests", "revalidate"]) {
      const value = payload[field];
      if (typeof value === "string") edits[field] = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      else if (Array.isArray(value) && value.every((item) => typeof item === "string")) edits[field] = value;
    }
    return edits;
  }

  return async function handleDashboardRequest(req, res, url) {
    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, service: "vcontinuity-admin", version: VCONTINUITY_VERSION });
      return true;
    }
    if (req.method === "POST" && ["/api/action", "/decision"].includes(url.pathname)) {
      // A local CLI may omit Origin; a browser must match the exact local page.
      const origin = req.headers.origin;
      const site = req.headers["sec-fetch-site"];
      if ((origin !== undefined && origin !== "http://" + req.headers.host) ||
          (site !== undefined && site !== "same-origin" && site !== "none")) {
        sendJson(res, 403, { ok: false, error: "Ação permitida somente a partir do painel local." });
        return true;
      }
      const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
      if (type !== (url.pathname === "/decision" ? "application/x-www-form-urlencoded" : "application/json")) {
        sendJson(res, 415, { ok: false, error: "Formato de requisição inválido." });
        return true;
      }
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      await renderDashboardPage(res);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/decision") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("csrf") !== oauth.adminCsrf) {
        sendHtml(res, 403, "<h1>Invalid CSRF token</h1>");
        return true;
      }
      const decision = form.get("decision");
      try {
        if (decision === "revoke") {
          await oauth.revokeConnection(form.get("connectionId") || "");
          await renderDashboardPage(res, "Conexão OAuth revogada com sucesso.");
          return true;
        }
        if (decision === "deny") {
          await oauth.decidePending({ id: form.get("id") || "", decision: "deny" });
          await renderDashboardPage(res, "Solicitação de acesso negada.");
          return true;
        }
        if (decision === "approve") {
          const scopes = form.getAll("scope");
          await oauth.decidePending({ id: form.get("id") || "", decision: "approve", scopes });
          await renderDashboardPage(res, "Acesso aprovado. Você já pode voltar à guia de autorização.");
          return true;
        }
        await renderDashboardPage(res, "Decisão desconhecida.");
        return true;
      } catch (error) {
        await renderDashboardPage(res, error.message || "Falha ao processar decisão.", 400);
        return true;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/overview") {
      const oauthPromise = oauth.adminSnapshot();
      const [health, oauthSnap, works, jobs, transfers] = await Promise.all([
        getDeepHealth(),
        oauthPromise,
        oauthPromise.then((snapshot) => collectWorksOverview(snapshot.activeGrants)),
        manageJob({ action: "list" }),
        collectTransfersOverview(),
      ]);
      sendJson(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
        version: VCONTINUITY_VERSION,
        ports,
        workspaceRoots: config.workspaceRoots,
        webToolNames: VCONTINUITY_WEB_TOOL_NAMES,
        agentToolNames: ["vcontinuity.work"],
        health,
        oauth: oauthSnap,
        works,
        jobs,
        transfers,
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/work") {
      const workId = url.searchParams.get("workId") || "";
      if (!workId) {
        sendJson(res, 400, { ok: false, error: "workId is required" });
        return true;
      }
      try {
        sendJson(res, 200, await workContextService.inspect(workId, { historyLimit: 200, includeHistory: true }));
      } catch (error) {
        errorReply(res, error);
      }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/work/checkpoint") {
      try {
        const workId = url.searchParams.get("workId");
        const sequence = Number(url.searchParams.get("sequence"));
        sendJson(res, 200, await workContextService.readCheckpoint(workId, sequence));
      } catch (error) { errorReply(res, error); }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/project") {
      try {
        const cwd = url.searchParams.get("cwd")?.trim();
        if (!cwd) throw new Error("Informe a pasta do projeto.");
        const real = await safePath(cwd, true, true);
        sendJson(res, 200, { ok: true, cwd: real, continuity: await workContextService.discover(cwd) });
      } catch (error) { errorReply(res, error); }
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/job") {
      const jobId = url.searchParams.get("jobId") || "";
      try {
        const data = await manageJob({ action: "read", jobId });
        sendJson(res, 200, data);
      } catch (error) {
        sendJson(res, 404, { ok: false, error: error.message });
      }
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      let payload = {};
      try {
        payload = JSON.parse(await readBody(req));
        if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("Invalid JSON");
      } catch {
        sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return true;
      }
      const csrf = req.headers["x-csrf-token"] || payload.csrf;
      if (csrf !== oauth.adminCsrf) {
        sendJson(res, 403, { ok: false, error: "Invalid CSRF token" });
        return true;
      }
      try {
        const action = String(payload.action || "");
        if (action === "oauth_approve") {
          const result = await oauth.decidePending({
            id: payload.id,
            decision: "approve",
            scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
          });
          sendJson(res, 200, result);
          return true;
        }
        if (action === "oauth_deny") {
          const result = await oauth.decidePending({ id: payload.id, decision: "deny" });
          sendJson(res, 200, result);
          return true;
        }
        if (action === "oauth_revoke") {
          await oauth.revokeConnection(String(payload.connectionId || ""));
          sendJson(res, 200, { ok: true });
          return true;
        }
        if (action === "oauth_prune" || action === "job_prune") {
          const result = await runCleanup(action, payload);
          sendJson(res, 200, result);
          return true;
        }
        if (action === "job_cancel") {
          const result = await manageJob({ action: "cancel", jobId: String(payload.jobId || "") });
          sendJson(res, 200, result);
          return true;
        }
        if (action === "job_restore") {
          const result = await restoreJobs(payload.archiveId);
          sendJson(res, 200, result);
          return true;
        }
        if (action === "work_create") {
          if (typeof payload.root !== "string" || !payload.root.trim()) throw new Error("Informe a pasta do projeto.");
          const continuity = await workContextService.discover(payload.root.trim());
          if (continuity.works.some((work) => work.status !== "closed")) {
            throw new Error("WORK_ALREADY_EXISTS:" + continuity.works[0].workId);
          }
          const result = await workContextOp({
            action: "create", workId: continuity.suggestedWorkId, root: continuity.root,
            title: typeof payload.title === "string" && payload.title.trim() || continuity.suggestedTitle,
            goal: typeof payload.goal === "string" ? payload.goal.trim() : "",
            client: "dashboard-local",
          }, { surface: "agent", activate: false });
          sendJson(res, 200, result);
          return true;
        }
        if (["work_checkpoint", "work_handoff", "work_close"].includes(action)) {
          const result = await workContextOp({
            ...workEdits(payload),
            action: action.slice("work_".length),
            workId: String(payload.workId || ""),
            client: "dashboard-local",
            toClient: typeof payload.toClient === "string" ? payload.toClient : undefined,
          }, { surface: "agent", activate: false });
          sendJson(res, 200, result);
          return true;
        }
        if (action === "work_activate") {
          const surface = payload.surface;
          if (surface !== "web" && surface !== "agent") throw new Error("Escolha onde deseja retomar o trabalho.");
          const { work } = await workContextService.inspect(payload.workId);
          if (work.status === "closed") throw new Error("Este trabalho está encerrado.");
          let binding = null;
          if (payload.connectionId) {
            const grant = (await oauth.adminSnapshot()).activeGrants.find((item) =>
              item.connectionId === payload.connectionId && item.scopes.includes("works:read"));
            if (surface !== "web" || !grant) throw new Error("A conexão Web não está disponível.");
            binding = "oauth:" + grant.connectionId;
          }
          await workContextService.setActive(surface, work.workId, "dashboard-local", binding);
          sendJson(res, 200, { ok: true });
          return true;
        }
        sendJson(res, 400, { ok: false, error: "Unsupported dashboard action: " + action });
        return true;
      } catch (error) {
        errorReply(res, error);
        return true;
      }
    }

    return false;
  };
}
