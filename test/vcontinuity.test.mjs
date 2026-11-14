import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { createIsolatedEnv, projectRoot } from "../scripts/isolated-runtime.mjs";

const iso = await createIsolatedEnv({
  prefix: "vcontinuity-unit-",
  includeProjectRoot: true,
  applyToProcess: true,
});

const {
  config, projectContext, safePath, listTree, readFiles, patchExact, writeText,
} = await import("../src/vcontinuity/filesystem.mjs");
const {
  runCommand, runCommands, searchFiles, gitOperation,
} = await import("../src/vcontinuity/executor.mjs");
const { manageJob } = await import("../src/vcontinuity/job-manager.mjs");
const { WorkContextService } = await import("../src/vcontinuity/work-context.mjs");
const {
  OAUTH_SCOPES, requiredScopesForTool,
  createOAuthService,
} = await import("../src/vcontinuity/oauth.mjs");
const { fileTransferService } = await import("../src/vcontinuity/file-transfer-service.mjs");
const {
  createVContinuityWebServer, VCONTINUITY_WEB_TOOL_NAMES,
} = await import("../src/vcontinuity/web.mjs");
const { createVContinuityAgentServer } = await import("../src/vcontinuity/agent.mjs");
const { createDashboardHandler } = await import("../src/vcontinuity/dashboard.mjs");

const root = config.defaultCwd;
const tempRoot = path.join(root, ".vc-" + crypto.randomBytes(4).toString("hex"));

test.after(async () => {
  await fileTransferService.close().catch(() => {});
  await iso.cleanup();
});

test("project context is generic and exposes no external-agent capability", async () => {
  const context = await projectContext(projectRoot);
  assert.equal(context.name, "vContinuity");
  assert.equal(context.version, "0.7.0");
  assert.equal(context.capabilities.externalAgentRuntime, false);
  assert.equal(context.capabilities.computerUse, false);
  assert.ok(context.workspaceRoots.some((value) => path.resolve(value).toLowerCase() === path.resolve(iso.workspaceRoot).toLowerCase()));
  assert.ok(context.instructions.some((item) => item.path.endsWith("AGENTS.md")));
});

test("workspace roots reject escapes while project files remain accessible", async () => {
  await assert.rejects(() => safePath("C:\\Windows\\System32", true, true), /Outside workspace roots/);
  const resolved = await safePath(root, true, true);
  assert.equal(path.resolve(resolved).toLowerCase(), path.resolve(root).toLowerCase());
});

test("filesystem list/read/write/patch provide hashes and guarded edits", async () => {
  await fs.mkdir(tempRoot, { recursive: true });
  const file = path.join(tempRoot, "sample.txt");
  try {
    const written = await writeText({ path: file, content: "alpha\nbeta\n", createDirs: true });
    assert.match(written.sha256, /^[a-f0-9]{64}$/);
    const listed = await listTree(tempRoot, 1, 20);
    assert.ok(listed.entries.some((entry) => entry.path === "sample.txt"));
    const read = await readFiles([file], 10000);
    assert.equal(read.results[0].content, "alpha\nbeta\n");
    assert.equal(read.results[0].sha256, written.sha256);
    const preview = await patchExact({
      path: file, expectedText: "beta", replacementText: "gamma", expectedSha256: written.sha256, previewOnly: true,
    });
    assert.equal(preview.changed, false);
    const patched = await patchExact({
      path: file, expectedText: "beta", replacementText: "gamma", expectedSha256: written.sha256,
    });
    assert.equal(patched.changed, true);
    assert.equal(await fs.readFile(file, "utf8"), "alpha\ngamma\n");
    await assert.rejects(() => patchExact({ path: file, expectedText: "beta", replacementText: "x" }), /Occurrence mismatch/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("foreground execution supports single and batched commands", async () => {
  const single = await runCommand({ command: [process.execPath, "-e", "process.stdout.write('VC_OK')"], cwd: root });
  assert.equal(single.exitCode, 0);
  assert.equal(single.stdout, "VC_OK");
  const batched = await runCommands([
    { id: "a", command: [process.execPath, "-e", "process.stdout.write('A')"], cwd: root },
    { id: "b", command: [process.execPath, "-e", "process.stdout.write('B')"], cwd: root },
  ], "parallel");
  assert.equal(batched.count, 2);
  assert.equal(batched.ok, true);
});

test("ripgrep search returns structured local matches", async () => {
  const result = await searchFiles("VCONTINUITY_WEB_TOOL_NAMES", projectRoot, 20, false);
  assert.ok(result.matches.some((entry) => entry.file?.endsWith("web.mjs")));
  const files = await searchFiles("package.json", projectRoot, 20, true);
  assert.ok(files.files.some((entry) => entry.path.endsWith("package.json")));
});

test("persistent jobs start, complete and expose output", async () => {
  const started = await manageJob({
    action: "start",
    title: "unit-job",
    command: [process.execPath, "-e", "setTimeout(()=>console.log('JOB_TEST_OK'),100)"],
    cwd: root,
    timeoutMs: 5000,
  });
  assert.match(started.jobId, /^job_[a-f0-9]{12}$/);
  const waited = await manageJob({ action: "wait", jobId: started.jobId, timeoutMs: 5000 });
  assert.equal(waited.snapshots[0].status, "completed");
  assert.match(waited.snapshots[0].stdoutTail, /JOB_TEST_OK/);
});

test("git tool uses generic branch/worktree semantics with no product prefix", async () => {
  const repo = path.join(root, ".vc-git-" + crypto.randomBytes(4).toString("hex"));
  await fs.mkdir(repo, { recursive: true });
  try {
    assert.equal((await runCommand({ command: ["git", "init"], cwd: repo })).exitCode, 0);
    await fs.writeFile(path.join(repo, "a.txt"), "a\n");
    await runCommand({ command: ["git", "add", "."], cwd: repo });
    await runCommand({ command: ["git", "-c", "user.email=test@example.invalid", "-c", "user.name=vContinuity Test", "commit", "-m", "init"], cwd: repo });
    const status = await gitOperation({ action: "status", cwd: repo });
    assert.equal(status.exitCode, 0);
    const branch = "phase2-test-" + crypto.randomBytes(2).toString("hex");
    const created = await gitOperation({ action: "branch_create", cwd: repo, branch });
    assert.equal(created.exitCode, 0);
    const branches = await gitOperation({ action: "branch_list", cwd: repo });
    assert.match(branches.stdout, new RegExp(branch));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("shared Work Context hands off between web and agent with revision guards", async () => {
  const works = path.join(iso.worksDir, ".vc-works-" + crypto.randomBytes(4).toString("hex"));
  const service = new WorkContextService({ root: works });
  const workId = "handoff-" + crypto.randomBytes(4).toString("hex");
  try {
    const created = await service.create({
      workId, title: "Handoff", goal: "Share operational context", root, client: "local-agent", surface: "agent",
    });
    assert.equal(created.work.revision, 1);
    await service.recordToolEvent({
      surface: "agent", tool: "vcontinuity.exec",
      args: { command: ["node", "--version"], cwd: root },
      result: { exitCode: 0 },
    });
    await service.semanticUpdate({
      workId, surface: "agent", client: "local-agent", expectedRevision: 1,
      summary: "Local agent completed step A.", completed: ["Step A"],
      nextSteps: ["Continue in Web"], filesChanged: ["src/example.mjs"],
    }, { checkpoint: true, handoff: true });
    const web = await service.resume({ workId, surface: "web", client: "chatgpt-web" });
    assert.match(web.context, /Local agent completed step A/);
    assert.ok(web.recentEvents.some((event) => event.tool === "vcontinuity.exec"));
    await assert.rejects(() => service.semanticUpdate({
      workId, surface: "web", expectedRevision: 1, summary: "stale",
    }), /WORK_REVISION_CONFLICT/);
  } finally {
    await fs.rm(works, { recursive: true, force: true });
  }
});

test("Work Context compaction redacts common secret patterns", async () => {
  const works = path.join(iso.worksDir, ".vc-redact-" + crypto.randomBytes(4).toString("hex"));
  const service = new WorkContextService({ root: works });
  const workId = "redact-" + crypto.randomBytes(4).toString("hex");
  try {
    await service.create({ workId, title: "Redaction", goal: "Safe continuity", root, client: "agent", surface: "agent" });
    const result = await service.compact({
      workId, surface: "agent", expectedRevision: 1,
      currentState: "token=abc123secretvalue", completed: ["api_key=supersecretvalue"],
    });
    assert.doesNotMatch(result.compact, /abc123secretvalue|supersecretvalue/);
    assert.match(result.compact, /\[REDACTED\]/);
  } finally {
    await fs.rm(works, { recursive: true, force: true });
  }
});

test("OAuth scopes contain only vContinuity capabilities and map tools correctly", () => {
  assert.deepEqual(OAUTH_SCOPES, [
    "read", "files:read", "files:write", "commands:run",
    "works:read", "works:write", "git:read", "git:write",
  ]);
  assert.deepEqual(requiredScopesForTool("vcontinuity.fs_read", {}), ["files:read"]);
  assert.deepEqual(requiredScopesForTool("vcontinuity.fs_write", {}), ["files:write"]);
  assert.deepEqual(requiredScopesForTool("vcontinuity.exec", {}), ["commands:run"]);
  assert.deepEqual(requiredScopesForTool("vcontinuity.git", { action: "worktree_create" }), ["git:write"]);
  assert.deepEqual(requiredScopesForTool("vcontinuity.work", { action: "checkpoint" }), ["works:read", "works:write"]);
});

test("file transfer workflow is generic vContinuity transport", async () => {
  const workflow = await fileTransferService.workflow();
  assert.equal(workflow.owner, "vContinuity");
  assert.equal(path.resolve(workflow.root).toLowerCase(), path.resolve(iso.fileRoot).toLowerCase());
  assert.equal(workflow.transfer_tool, "vcontinuity.transfer");
  assert.equal(workflow.picker_tool, "vcontinuity.file_picker");
});

test("MCP constructors expose vContinuity-only contracts", async () => {
  const web = createVContinuityWebServer();
  const agent = createVContinuityAgentServer();
  assert.equal(VCONTINUITY_WEB_TOOL_NAMES.length, 13);
  assert.ok(VCONTINUITY_WEB_TOOL_NAMES.every((name) => name.startsWith("vcontinuity.")));
  assert.equal(typeof web.registerTool, "function");
  assert.equal(typeof agent.registerTool, "function");
  await web.close();
  await agent.close();
});

test("local dashboard renders HTML with CSRF token and serves overview API", async () => {
  const oauthDir = path.join(iso.oauthDir, ".vc-oauth-" + crypto.randomBytes(4).toString("hex"));
  await fs.mkdir(oauthDir, { recursive: true });
  const oauth = await createOAuthService({
    publicOrigin: iso.publicOrigin,
    resourcePath: "/mcp/web",
    publicGatewayPort: iso.ports.publicGateway,
    adminPort: iso.ports.admin,
    storageRoot: oauthDir,
  });
  const handler = createDashboardHandler({
    oauth,
    ports: iso.ports,
    getDeepHealth: async () => ({ ok: true, version: "0.7.0", webTools: 13, agentTools: 1 }),
  });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!await handler(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + srv.address().port;
  try {
    const { workContextService } = await import("../src/vcontinuity/work-context.mjs");
    const workId = "legacy-guidance";
    await workContextService.create({ workId, activate: false });
    await workContextService.recordToolEvent({
      workId, tool: "vcontinuity.exec", result: { ok: true },
    });
    await fs.unlink(path.join(workContextService.workDir(workId), "activity.json"));

    const pageRes = await fetch(baseUrl + "/");
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /vContinuity — Painel de Controle Local/);
    assert.match(html, new RegExp('name="csrf" value="' + oauth.adminCsrf + '"'));

    const overviewRes = await fetch(baseUrl + "/api/overview");
    assert.equal(overviewRes.status, 200);
    const overview = await overviewRes.json();
    assert.equal(overview.ok, true);
    assert.equal(overview.version, "0.7.0");
    assert.equal(overview.webToolNames.length, 13);
    const detail = await (await fetch(baseUrl + "/api/work?workId=" + workId)).json();
    assert.equal(detail.guidance.status, "checkpoint_recommended");
    assert.deepEqual(overview.works.works.find((work) => work.workId === workId).guidance, detail.guidance);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
    await fs.rm(oauthDir, { recursive: true, force: true });
  }
});
