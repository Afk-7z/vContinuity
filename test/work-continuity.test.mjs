import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createIsolatedEnv } from "../scripts/isolated-runtime.mjs";

const fixture = await createIsolatedEnv({ applyToProcess: true });
test.after(() => fixture.cleanup());
const { WorkContextService } = await import("../src/vcontinuity/work-context.mjs");

function workService(name) {
  return new WorkContextService({ root: path.join(fixture.dataRoot, name) });
}

test("a failed checkpoint leaves the previous revision intact and can be retried", async () => {
  const service = workService("checkpoint-rollback");
  await service.create({ workId: "sample", goal: "Original", activate: false });
  const dir = service.workDir("sample");
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === path.join(dir, "work.json")) {
      throw Object.assign(new Error("Simulated replacement failure"), { code: "EPERM" });
    }
    return rename(from, to);
  };
  const update = () => service.semanticUpdate({
    workId: "sample", expectedRevision: 1, summary: "Updated", activate: false,
  }, { checkpoint: true });
  try {
    await assert.rejects(update(), { code: "EPERM" });
  } finally {
    fs.rename = rename;
  }
  const previous = await service.inspect("sample", { includeHistory: true });
  assert.equal(previous.work.revision, 1);
  assert.equal(previous.state.revision, 1);
  assert.equal(previous.summary.currentState, "Original");
  assert.equal(previous.state.lastCheckpoint, 0);
  assert.deepEqual(previous.checkpoints, []);
  assert.deepEqual(previous.history.events.map(({ type }) => type), ["work_created"]);
  assert.equal((await update()).checkpoint, 1);
  assert.match((await service.readCheckpoint("sample", 1)).content, /Updated/);
});

test("a new service instance recovers a pending revision before returning context", async () => {
  const service = workService("checkpoint-recovery");
  await service.create({ workId: "sample", goal: "Original", activate: false });
  const dir = service.workDir("sample");
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if ([path.join(dir, "work.json"), path.join(dir, "state.json")].includes(to)) {
      if (to.endsWith("state.json") && JSON.parse(await fs.readFile(from, "utf8")).revision === 2) {
        return rename(from, to);
      }
      throw Object.assign(new Error("Simulated replacement failure"), { code: "EPERM" });
    }
    return rename(from, to);
  };
  try {
    await assert.rejects(service.compact({
      workId: "sample", expectedRevision: 1, currentState: "Updated", activate: false,
    }), /recovery is pending/);
  } finally {
    fs.rename = rename;
  }
  const recovered = await new WorkContextService({ root: service.root }).inspect("sample");
  assert.equal(recovered.work.revision, 1);
  assert.equal(recovered.state.lastCompaction, 0);
  assert.equal(recovered.compact, null);
  assert.equal(recovered.summary.currentState, "Original");
});

test("discovery identifies the repository from a subfolder without registering it", async () => {
  const service = workService("discovery");
  const project = path.join(fixture.workspaceRoot, "Example Project");
  const nested = path.join(project, "src");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(nested);
  const absent = await service.discover(nested);
  assert.equal(absent.status, "unregistered");
  assert.equal(absent.suggestedWorkId, "example-project");
  assert.equal(absent.root, project);
  assert.equal((await service.list()).count, 0);

  const first = await service.create({ workId: absent.suggestedWorkId, root: project, activate: false });
  assert.equal(await service.getActive("agent"), null);
  const found = await service.discover(nested);
  assert.equal(found.status, "ready");
  assert.equal(found.works[0].workId, first.work.workId);

  const another = path.join(fixture.workspaceRoot, "Another", "Example Project");
  await fs.mkdir(another, { recursive: true });
  const different = await service.discover(another);
  assert.equal(different.status, "unregistered");
  assert.notEqual(different.suggestedWorkId, absent.suggestedWorkId);
  await assert.rejects(() => service.discover(path.dirname(fixture.workspaceRoot)), /Outside workspace roots/);
});

test("resume favors the newest revision and includes material activity after its snapshot", async () => {
  const service = workService("resume");
  await service.create({ workId: "sample", root: fixture.workspaceRoot, title: "Initial" });
  await service.compact({ workId: "sample", expectedRevision: 1, currentState: "Old summary" });
  await service.semanticUpdate({
    workId: "sample", expectedRevision: 2, summary: "New handoff", tests: ["Verified locally"],
    nextSteps: ["Review files"], revalidate: ["Check service after restart"],
  }, { checkpoint: true, handoff: true });
  await service.recordToolEvent({ surface: "agent", workId: "sample", tool: "vcontinuity.fs_write", args: { path: "example.txt" }, result: { ok: true } });
  await service.recordToolEvent({ surface: "agent", workId: "sample", tool: "vcontinuity.fs_read", result: { ok: true } });
  const handoff = await service.resume({ workId: "sample", surface: "web" });
  assert.equal(handoff.continuationSource, "handoff");
  assert.equal(handoff.continuationRevision, 3);
  assert.match(handoff.continuationContext, /New handoff/);
  assert.doesNotMatch(handoff.continuationContext, /Old summary|vcontinuity\.fs_read/);
  assert.match(handoff.continuationContext, /Recent activity after this summary[\s\S]*vcontinuity\.fs_write/);
  assert.equal(handoff.guidance.reason, "recent_activity");
  assert.equal((await service.guidanceFor(handoff.work, handoff.state)).status, "checkpoint_recommended");
  assert.equal((await service.discover(fixture.workspaceRoot)).status, "checkpoint_recommended");

  await service.semanticUpdate({ workId: "sample", expectedRevision: 3, summary: "Checkpoint after handoff" }, { checkpoint: true });
  const newest = await service.inspect("sample", { includeHistory: true });
  assert.equal(newest.continuationSource, "context");
  assert.equal(newest.continuationRevision, 4);
  assert.match(newest.continuationContext, /Checkpoint after handoff/);
  assert.doesNotMatch(newest.continuationContext, /Recent activity after this summary/);
  assert.equal((await service.guidanceFor(newest.work, newest.state)).status, "ready");
  assert.deepEqual(newest.summary.tests, ["Verified locally"]);
  assert.deepEqual(newest.summary.nextSteps, ["Review files"]);
  assert.deepEqual(newest.summary.revalidate, ["Check service after restart"]);
  assert.deepEqual(newest.checkpoints.map(({ sequence }) => sequence), [2, 1]);
  assert.match((await service.readCheckpoint("sample", 1)).content, /New handoff/);
  assert.match((await service.readCheckpoint("sample", 2)).content, /Checkpoint after handoff/);
});

test("active work is independent per connection and stale concurrent writes are rejected", async () => {
  const service = workService("bindings");
  const a = "oauth:fixture-connection-a";
  const b = "oauth:fixture-connection-b";
  await service.create({ workId: "alpha", surface: "web", binding: a });
  await service.create({ workId: "beta", surface: "web", binding: b });
  assert.equal(await service.getActive("web"), null);
  assert.equal((await service.getActive("web", a)).workId, "alpha");
  assert.equal((await service.getActive("web", b)).workId, "beta");
  await service.recordToolEvent({ surface: "web", binding: a, tool: "vcontinuity.exec", args: { command: ["node", "--version"] }, result: { ok: true } });
  assert.equal((await service.history({ workId: "alpha" })).commands.length, 1);
  assert.equal((await service.history({ workId: "beta" })).commands.length, 0);

  const attempts = await Promise.allSettled([
    service.semanticUpdate({ workId: "alpha", surface: "web", binding: a, expectedRevision: 1, summary: "First" }, { checkpoint: true }),
    service.semanticUpdate({ workId: "alpha", surface: "agent", expectedRevision: 1, summary: "Stale" }, { checkpoint: true }),
  ]);
  assert.equal(attempts[0].status, "fulfilled");
  assert.equal(attempts[1].reason.code, "WORK_REVISION_CONFLICT");
  assert.equal(attempts[1].reason.currentRevision, 2);
  assert.equal((await service.status({ workId: "alpha" })).state.currentTask, "First");
  assert.equal((await service.getActive("web", b)).workId, "beta");
  await service.semanticUpdate({ workId: "alpha", expectedRevision: 2, surface: "web", binding: a }, { close: true, checkpoint: true });
  assert.equal(await service.getActive("web", a), null);
});

test("a checkpoint with no edited notes retains the latest compacted state", async () => {
  const service = workService("partial-checkpoint");
  await service.create({ workId: "sample", goal: "Initial goal" });
  await service.compact({
    workId: "sample", currentState: "New status", tests: ["Ran the regression"], nextSteps: ["Review changes"],
  });
  await assert.rejects(() => service.semanticUpdate({ workId: "sample", expectedRevision: 1, phase: "stale" }), { code: "WORK_REVISION_CONFLICT" });
  await service.semanticUpdate({ workId: "sample", expectedRevision: 2, phase: "review" }, { checkpoint: true });
  const next = await service.inspect("sample");
  assert.equal(next.continuationSource, "context");
  assert.equal(next.summary.currentState, "New status");
  assert.deepEqual(next.summary.tests, ["Ran the regression"]);
  assert.deepEqual(next.summary.nextSteps, ["Review changes"]);
});

test("manual checkpoints and journal summaries do not store common credentials or command arguments", async () => {
  const service = workService("redaction");
  await service.create({ workId: "sample" });
  const fake = "never-store-this-fixture";
  await service.semanticUpdate({
    workId: "sample", summary: "Bearer " + fake, tests: ["password=" + fake],
  }, { checkpoint: true, handoff: true });
  await service.recordToolEvent({
    surface: "agent", workId: "sample", tool: "vcontinuity.exec",
    args: { command: ["node", "--secret", fake], powershell: "echo " + fake }, result: { ok: true },
  });
  const result = await service.inspect("sample", { includeHistory: true });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(fake));
  assert.match(result.context, /\[REDACTED\]/);
});
