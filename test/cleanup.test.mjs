import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test, after } from "node:test";

const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "vcontinuity-cleanup-"));
after(async () => fs.rm(root, { recursive: true, force: true }));
process.env.VCONTINUITY_DATA_ROOT = path.relative(process.cwd(), root);
process.env.VCONTINUITY_CONFIG = path.join(root, "runtime.json");
for (const key of ["VCONTINUITY_OAUTH_CONFIG", "VCONTINUITY_OAUTH_STORAGE_ROOT", "VCONTINUITY_PUBLIC_ORIGIN", "VCONTINUITY_RESOURCE_PATH"]) delete process.env[key];
await fs.writeFile(process.env.VCONTINUITY_CONFIG, JSON.stringify({ workspaceRoots: [root], defaultCwd: root, maxConcurrent: 1 }));

const { manageJob, previewJobPrune, pruneJobs, restoreJobs } = await import("../src/vcontinuity/job-manager.mjs");
const { createOAuthService, loadOAuthConfig } = await import("../src/vcontinuity/oauth.mjs");
const jobs = path.join(root, "jobs");
const createdAt = "2020-01-01T00:00:00.000Z";
const completedAt = "2020-01-02T00:00:00.000Z";
const origin = "https://example.test";

async function job(jobId, fields = {}, parent = jobs) {
  const dir = path.join(parent, jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ jobId, title: "Completed job", status: "completed", createdAt, completedAt, supervisorPid: null, pid: null, ...fields }));
  return dir;
}

test("jobs move only reviewed, verified records, and can restore logs without replacing another record", async () => {
  const terminal = "job_000000000001", active = "job_000000000002", live = "job_000000000003";
  const unsafe = "job_000000000004", unreviewed = "job_000000000005", mismatched = "job_000000000006";
  const dir = await job(terminal);
  await fs.writeFile(path.join(dir, "stdout.log"), "recover me");
  await job(active, { status: "queued", completedAt: null });
  await job(live, { supervisorPid: process.pid });
  await job(unreviewed);
  await job(mismatched, { jobId: terminal });
  const outside = await job(unsafe, {}, path.join(root, "project"));
  await fs.symlink(outside, path.join(jobs, unsafe), process.platform === "win32" ? "junction" : "dir");

  const { items, count, candidates } = await previewJobPrune();
  assert.equal(count, 2);
  assert.deepEqual(items.map(x => x.jobId), [terminal, unreviewed]);
  assert.equal((await manageJob({ action: "list" })).jobs.find(x => x.jobId === active).status, "interrupted");
  const archiveRoot = path.join(root, "jobs-archive");
  await fs.symlink(path.join(root, "project"), archiveRoot, process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual(await pruneJobs({ jobIds: [terminal], candidates }), { ok: false, archived: 0, failed: [{ jobId: terminal, reason: "unsafe_path" }] });
  await fs.rename(archiveRoot, path.join(root, "unsafe-archive-fixture"));
  const result = await pruneJobs({ jobIds: [terminal, terminal, active, live, unsafe, mismatched, "../project"], candidates: (await previewJobPrune()).candidates });
  assert.equal(result.archived, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map(x => x.reason), ["not_reviewed", "not_reviewed", "not_reviewed", "not_reviewed", "invalid_job_id"]);
  assert.equal((await previewJobPrune()).count, 1);
  assert.equal((await manageJob({ action: "list" })).count, 4);
  assert.equal(JSON.parse(await fs.readFile(path.join(outside, "state.json"), "utf8")).jobId, unsafe);

  await job(terminal, { title: "Conflict" });
  const blocked = await restoreJobs(result.archiveId);
  assert.deepEqual(blocked, { ok: false, restored: 0, failed: [{ jobId: terminal, reason: "destination_exists" }] });
  await fs.rename(dir, path.join(root, "conflict"));
  assert.deepEqual(await restoreJobs(result.archiveId), { ok: true, restored: 1, failed: [] });
  assert.equal(await fs.readFile(path.join(dir, "stdout.log"), "utf8"), "recover me");
  await assert.rejects(restoreJobs("../project"), /Invalid archiveId/);

  const previews = await Promise.all([previewJobPrune(), previewJobPrune()]);
  const race = await Promise.all(previews.map(({ candidates }) => pruneJobs({ jobIds: [terminal], candidates })));
  assert.equal(race.reduce((sum, x) => sum + x.archived, 0), 1);
  assert.equal(race.reduce((sum, x) => sum + x.failed.length, 0), 1);
  const winner = race.find(x => x.archived === 1);
  assert.equal(await fs.readFile(path.join(archiveRoot, winner.archiveId, terminal, "stdout.log"), "utf8"), "recover me");
});

test("job confirmation rejects a replacement with the same ID and identical state bytes", async () => {
  const id = "job_000000000007";
  const dir = await job(id);
  const { candidates } = await previewJobPrune();
  const original = path.join(root, "original-generation");
  await fs.rename(dir, original);
  await job(id);
  const stateFile = path.join(dir, "state.json");
  assert.equal(await fs.readFile(stateFile, "utf8"), await fs.readFile(path.join(original, "state.json"), "utf8"));
  assert.deepEqual(await pruneJobs({ jobIds: [id], candidates }), { ok: false, archived: 0, failed: [{ jobId: id, reason: "generation_changed" }] });
  assert.deepEqual(await pruneJobs({ jobIds: [id], candidates }), { ok: false, archived: 0, failed: [{ jobId: id, reason: "not_reviewed" }] });
  assert.equal((await manageJob({ action: "read", jobId: id })).status, "completed");

  const updated = await previewJobPrune();
  await fs.writeFile(stateFile, JSON.stringify({ ...JSON.parse(await fs.readFile(stateFile, "utf8")), title: "Updated" }));
  assert.equal((await pruneJobs({ jobIds: [id], candidates: updated.candidates })).failed[0].reason, "generation_changed");
  const marker = path.join(root, "jobs-archive", `${id}.lock`);
  await fs.writeFile(marker, "another process owns this lock", { flag: "wx" });
  assert.equal((await pruneJobs({ jobIds: [id], candidates: (await previewJobPrune()).candidates })).failed[0].reason, "locked_or_denied");
  assert.equal(await fs.readFile(marker, "utf8"), "another process owns this lock");
  await fs.rename(marker, path.join(root, "lock-fixture"));
  assert.equal((await pruneJobs({ jobIds: [id], candidates: (await previewJobPrune()).candidates })).archived, 1);
});

test("the spawned supervisor inherits an absolute state root even when its cwd changes", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "cwd-"));
  const { jobId } = await manageJob({ action: "start", command: [process.execPath, "-e", "console.log('isolated worker')"], cwd });
  const { snapshots: [state] } = await manageJob({ action: "wait", jobId, timeoutMs: 6000 });
  assert.equal(state.status, "completed");
  assert.match(state.stdoutTail, /isolated worker/);
  assert.equal(JSON.parse(await fs.readFile(path.join(jobs, jobId, "state.json"), "utf8")).status, "completed");
});

function request(service, method, route, body = null, admin = false) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(payload) { this.body = String(payload ?? ""); } };
  const handle = admin ? service.handleAdminRequest : service.handlePublicRequest;
  return handle(req, res, new URL(route, origin)).then(() => res);
}

async function oauthFixture(name) {
  const storageRoot = path.join(root, name);
  const service = await createOAuthService({ publicOrigin: origin, storageRoot, adminPort: 7783 });
  const write = (key, items) => fs.writeFile(path.join(storageRoot, `${key}.json`), JSON.stringify({ schema: 1, [key]: items }));
  const read = async key => JSON.parse(await fs.readFile(path.join(storageRoot, `${key}.json`), "utf8"))[key];
  const register = name => service.registerClient({ client_name: name, redirect_uris: ["http://127.0.0.1/callback"] });
  const verifier = "a".repeat(43);
  const authorize = async clientId => {
    const query = new URLSearchParams({ client_id: clientId, response_type: "code", scope: "read", redirect_uri: "http://127.0.0.1/callback", code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url") });
    assert.equal((await request(service, "GET", `/oauth/authorize?${query}`)).status, 200);
    return (await service.adminSnapshot()).pendingRequests.find(x => x.clientId === clientId).id;
  };
  return { service, write, read, register, authorize, verifier };
}

test("OAuth cleanup is opaque, single use and revalidates only records that were reviewed", async () => {
  const { service, write, read, register, authorize } = await oauthFixture("oauth-prune");
  const unused = (await register("legitimate unused DCR")).client_id;
  const busy = (await register("editable test-looking name")).client_id;
  const idle = (await register("idle DCR")).client_id;
  const now = Math.floor(Date.now() / 1000);
  const grant = (connectionId, clientId, revokedAt = createdAt) => ({ connectionId, clientId, revokedAt });
  const tok = (connectionId, clientId, tokenHash, expiresAt = now - 1) => ({ connectionId, clientId, tokenHash, expiresAt, kind: "refresh", revokedAt: null });
  const gs = [grant("idle", idle), grant("pending", busy), grant("code", unused), grant("active", idle, null), grant("has-token", idle)];
  const ts = [tok("idle", idle, "secret-idle"), tok("pending", busy, "secret-pending"), tok("code", unused, "secret-code"), tok("active", idle, "secret-live", now + 3600), tok("has-token", idle, "secret-live-too", now + 3600)];
  await write("grants", gs);
  await write("tokens", ts);
  await write("codes", [{ connectionId: "code", expiresAt: now + 3600, usedAt: null }]);
  const preview = await service.previewOAuthPrune();
  assert.equal(preview.count, 4);
  assert.doesNotMatch(JSON.stringify(preview), /secret-|cw_client_|connectionId|tokenHash/);
  assert.equal((await service.pruneOAuthState({ candidates: structuredClone(preview.candidates) })).ok, false);
  await authorize(busy);
  await write("tokens", [...ts, tok("new", idle, "secret-new")]);
  assert.deepEqual(await service.pruneOAuthState({ candidates: preview.candidates }), { ok: true, removedGrants: 1, removedTokens: 1, removedClients: 0 });
  assert.equal((await service.pruneOAuthState({ candidates: preview.candidates })).ok, false);
  assert.deepEqual((await read("tokens")).map(x => x.connectionId), ["pending", "code", "active", "has-token", "new"]);
  assert.deepEqual((await read("grants")).map(x => x.connectionId), ["pending", "code", "active", "has-token"]);
  assert.equal((await read("clients")).length, 3);
});

test("OAuth claims a decision before awaiting storage and expired requests cannot be decided", async () => {
  const { service, read, register, authorize, verifier } = await oauthFixture("oauth-decisions");
  const { client_id: clientId } = await register("Client");
  const id = await authorize(clientId);
  const approval = service.decidePending({ id, decision: "approve", scopes: ["read"] });
  const denial = request(service, "POST", "/decision", new URLSearchParams({ id, decision: "deny", csrf: service.adminCsrf }).toString(), true);
  await assert.rejects(service.decidePending({ id, decision: "approve", scopes: ["read"] }), /already decided/);
  assert.equal((await approval).status, "approved");
  assert.match((await denial).body, /already decided/);
  assert.equal((await read("grants")).length, 1);
  assert.equal((await read("codes")).length, 1);
  const response = await request(service, "GET", `/oauth/pending-status?id=${id}`);
  const code = new URL(JSON.parse(response.body).redirect).searchParams.get("code");
  const form = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: "http://127.0.0.1/callback" });
  assert.equal((await request(service, "POST", "/oauth/token", form.toString())).status, 200);

  const expired = await authorize(clientId);
  const DateBefore = globalThis.Date;
  const future = Date.now() + 11 * 60 * 1000;
  globalThis.Date = class extends DateBefore { static now() { return future; } };
  try {
    await assert.rejects(service.decidePending({ id: expired, decision: "deny" }), /expired/);
  } finally { globalThis.Date = DateBefore; }
});

test("OAuth config honors the isolated root, explicit overrides and a clear missing-origin error", async () => {
  await assert.rejects(loadOAuthConfig(), /OAuth public origin is required/);
  const fallback = path.join(root, "oauth");
  await fs.mkdir(fallback);
  await fs.writeFile(path.join(fallback, "config.json"), JSON.stringify({ publicOrigin: origin }));
  assert.equal((await loadOAuthConfig()).storageRoot, fallback);
  const custom = path.join(root, "custom.json");
  const storage = path.join(root, "configured-oauth");
  await fs.writeFile(custom, JSON.stringify({ publicOrigin: origin, storageRoot: storage }));
  process.env.VCONTINUITY_OAUTH_CONFIG = custom;
  assert.equal((await loadOAuthConfig()).storageRoot, storage);
  process.env.VCONTINUITY_OAUTH_STORAGE_ROOT = path.join(root, "override-oauth");
  assert.equal((await loadOAuthConfig()).storageRoot, path.join(root, "override-oauth"));
});

test("simultaneous job starts cannot reserve the same slot", async () => {
  const start = () => manageJob({ action: "start", command: [process.execPath, "-e", "setTimeout(() => {}, 2000)"] });
  const results = await Promise.allSettled([start(), start()]);
  const accepted = results.filter((item) => item.status === "fulfilled");
  const rejected = results.filter((item) => item.status === "rejected");
  for (const { value } of accepted) await manageJob({ action: "wait", jobId: value.jobId, timeoutMs: 8000 });
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /Maximum active jobs reached/);
});
