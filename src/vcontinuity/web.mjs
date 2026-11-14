import { createRequire } from "node:module";
import { config, projectContext, safePath, listTree, readFiles, patchExact, writeText } from "./filesystem.mjs";
import { runCommand, runCommands, searchFiles, gitOperation } from "./executor.mjs";
import { manageJob } from "./job-manager.mjs";
import { workBinding, workContextService, workContextOp } from "./work-context.mjs";
import { assertToolScopes } from "./oauth.mjs";
import { VCONTINUITY_VERSION } from "./version.mjs";
import { workSchema, VCONTINUITY_WORKFLOW_INSTRUCTIONS } from "./agent.mjs";
import {
  transferSchema, handleTransfer, registerTransferResource, pickerResult,
  transferToolMeta, pickerToolMeta,
} from "./transfer.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

export const VCONTINUITY_WEB_TOOL_NAMES = Object.freeze([
  "vcontinuity.project",
  "vcontinuity.work",
  "vcontinuity.fs_list",
  "vcontinuity.fs_read",
  "vcontinuity.fs_search",
  "vcontinuity.fs_patch",
  "vcontinuity.fs_write",
  "vcontinuity.exec",
  "vcontinuity.job",
  "vcontinuity.git",
  "vcontinuity.transfer",
  "vcontinuity.file_picker",
  "vcontinuity.health",
]);

export const VCONTINUITY_WEB_INSTRUCTIONS = `vContinuity connects this web client to the user's authorized local computer and shared project context.

Use vcontinuity.project at the start of substantial local-project work to read the authorized roots and project instructions. Use filesystem tools for local files, vcontinuity.exec for bounded foreground commands, vcontinuity.job for long-running processes, vcontinuity.git for Git operations, and vcontinuity.work for cross-client continuity.

${VCONTINUITY_WORKFLOW_INSTRUCTIONS}

Do not assume access outside configured workspace roots. Do not invent local paths, file receipts, process results, or completed transfers. Verify mutations and tests. Revalidate mutable runtime facts before relying on old Work Context.

This Web surface intentionally has no external model/agent runtime and no Computer Use tools in this version.`;

function output(data) {
  if (data?.__mcpResult) {
    const { __mcpResult, ...result } = data;
    return result;
  }
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

function errorOutput(error) {
  const data = { ok: false, error: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
}

function commandSchema(z) {
  return z.object({
    id: z.string().max(128).optional(),
    command: z.array(z.string().max(32768)).min(1).max(128).optional(),
    powershell: z.string().min(1).max(65536).optional(),
    cwd: z.string().max(32768).optional(),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
    maxChars: z.number().int().min(1000).max(300000).optional(),
  }).strict();
}

export function createVContinuityWebServer({ runtimeStatusProvider = null } = {}) {
  const server = new McpServer({
    name: "vcontinuity",
    title: "vContinuity",
    version: VCONTINUITY_VERSION,
    description: "Local computer and shared-project bridge for authorized web AI clients.",
  }, { instructions: VCONTINUITY_WEB_INSTRUCTIONS });

  registerTransferResource(server);

  const register = (name, title, description, schema, handler, {
    readOnly = false,
    journal = true,
    openWorld = false,
    meta = undefined,
  } = {}) => {
    server.registerTool(name, {
      title,
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: Boolean(readOnly),
        destructiveHint: !readOnly,
        idempotentHint: Boolean(readOnly),
        openWorldHint: Boolean(openWorld),
      },
      ...(meta ? { _meta: meta } : {}),
    }, async (args, extra) => {
      let journalWorkId = null;
      try {
        if (extra?.http?.authInfo) assertToolScopes(name, args, extra.http.authInfo);
        if (journal && (!extra?.http?.authInfo || extra.http.authInfo.scopes?.includes("works:read"))) {
          // Capture the work when the request starts: a long call can finish
          // after this connection has already switched to a different work.
          const active = await workContextService.getActive("web", workBinding(extra)).catch(() => null);
          journalWorkId = active?.workId ?? null;
        }
        const data = await handler(args, extra);
        if (journalWorkId) await workContextService.recordToolEvent({ surface: "web", workId: journalWorkId, tool: name, args, result: data }).catch(() => {});
        return output(data);
      } catch (error) {
        if (journalWorkId) await workContextService.recordToolEvent({ surface: "web", workId: journalWorkId, tool: name, args, error }).catch(() => {});
        return errorOutput(error);
      }
    });
  };

  register(
    "vcontinuity.project",
    "Project Context",
    "Read authorized workspace roots, project instructions, and whether to register, resume, or checkpoint shared work.",
    z.object({ cwd: z.string().max(32768).optional() }).strict(),
    async ({ cwd }, extra) => {
      const project = await projectContext(cwd);
      const auth = extra?.http?.authInfo;
      const continuity = auth && !auth.scopes?.includes("works:read")
        ? { status: "requires_scope", requiredScope: "works:read" }
        : await workContextService.discover(cwd || config.defaultCwd).catch(() => ({ status: "unavailable" }));
      return { ...project, continuity };
    },
    { readOnly: true, journal: false },
  );

  register(
    "vcontinuity.work",
    "Shared Work Context",
    "Use automatically for substantive project work: list by root (or find a project by title), create if missing, resume, and checkpoint meaningful progress without waiting for user reminders. Also inspect, compact, hand off, or close work.",
    workSchema,
    async (args, extra) => {
      if (!["list", "status"].includes(args.action) && !args.workId) {
        throw new Error("workId is required for action " + args.action);
      }
      if (args.root && ["create", "update", "checkpoint", "handoff"].includes(args.action)) {
        args = { ...args, root: await safePath(args.root, true, true) };
      }
      return workContextOp(args, { surface: "web", binding: workBinding(extra) });
    },
    { journal: false },
  );

  register(
    "vcontinuity.fs_list",
    "List Files",
    "List a bounded directory tree inside authorized workspace roots without following symlinks outside those roots.",
    z.object({
      path: z.string().max(32768).optional(),
      depth: z.number().int().min(0).max(5).optional(),
      maxEntries: z.number().int().min(1).max(600).optional(),
    }).strict(),
    ({ path, depth, maxEntries }) => listTree(path, depth, maxEntries),
    { readOnly: true },
  );

  register(
    "vcontinuity.fs_read",
    "Read Files",
    "Read up to 100 UTF-8 files concurrently with SHA-256 receipts and truncation metadata.",
    z.object({
      paths: z.array(z.string().min(1).max(32768)).min(1).max(100),
      maxChars: z.number().int().min(1000).max(1000000).optional(),
    }).strict(),
    ({ paths, maxChars }) => readFiles(paths, maxChars),
    { readOnly: true },
  );

  register(
    "vcontinuity.fs_search",
    "Search Files",
    "Search text or filenames with ripgrep inside an authorized local workspace.",
    z.object({
      query: z.string().max(4000).default(""),
      cwd: z.string().max(32768).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      filesOnly: z.boolean().optional(),
    }).strict(),
    ({ query, cwd, limit, filesOnly }) => searchFiles(query, cwd, limit, filesOnly),
    { readOnly: true },
  );

  register(
    "vcontinuity.fs_patch",
    "Patch File",
    "Atomically replace exactly N occurrences in a UTF-8 file, optionally guarded by SHA-256.",
    z.object({
      path: z.string().min(1).max(32768),
      expectedText: z.string().min(1).max(500000),
      replacementText: z.string().max(500000),
      expectedOccurrences: z.number().int().min(1).max(100).optional(),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
      previewOnly: z.boolean().optional(),
    }).strict(),
    patchExact,
  );

  register(
    "vcontinuity.fs_write",
    "Write File",
    "Create or overwrite one UTF-8 file inside authorized roots; overwrite or hash-guard must be explicit.",
    z.object({
      path: z.string().min(1).max(32768),
      content: z.string().max(1000000),
      createDirs: z.boolean().optional(),
      overwrite: z.boolean().optional(),
      expectedSha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    }).strict(),
    writeText,
  );

  const oneCommand = commandSchema(z);
  register(
    "vcontinuity.exec",
    "Execute Commands",
    "Run one foreground command/PowerShell script or a batch of up to 20 commands sequentially or in parallel.",
    z.object({
      command: z.array(z.string().max(32768)).min(1).max(128).optional(),
      powershell: z.string().min(1).max(65536).optional(),
      cwd: z.string().max(32768).optional(),
      timeoutMs: z.number().int().min(100).max(120000).optional(),
      maxChars: z.number().int().min(1000).max(300000).optional(),
      commands: z.array(oneCommand).min(1).max(20).optional(),
      mode: z.enum(["sequential", "parallel", "allSettled"]).optional(),
    }).strict(),
    async (args) => args.commands
      ? runCommands(args.commands, args.mode || "sequential")
      : runCommand(args),
    { openWorld: true },
  );

  register(
    "vcontinuity.job",
    "Background Job",
    "Start, list, read, wait for, or cancel disk-persistent supervised local jobs.",
    z.object({
      action: z.enum(["start", "list", "read", "wait", "cancel"]),
      jobId: z.string().max(128).optional(),
      jobIds: z.array(z.string().max(128)).min(1).max(8).optional(),
      title: z.string().max(256).optional(),
      command: z.array(z.string().max(32768)).min(1).max(128).optional(),
      powershell: z.string().min(1).max(65536).optional(),
      cwd: z.string().max(32768).optional(),
      afterCursor: z.number().int().min(0).optional(),
      timeoutMs: z.number().int().min(0).max(1800000).optional(),
    }).strict(),
    manageJob,
    { openWorld: true },
  );

  register(
    "vcontinuity.git",
    "Git",
    "Inspect or modify Git status, diffs, logs, branches and worktrees without any product-specific branch prefix.",
    z.object({
      action: z.enum(["status","diff","log","branch_list","branch_create","branch_delete","worktree_list","worktree_create","worktree_remove"]),
      cwd: z.string().max(32768).optional(),
      staged: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      branch: z.string().max(256).optional(),
      targetPath: z.string().max(32768).optional(),
      force: z.boolean().optional(),
    }).strict(),
    gitOperation,
  );

  register(
    "vcontinuity.transfer",
    "File Transfer",
    "Import a native ChatGPT file into Windows, inspect import progress, inspect transfer locations, or export a verified local file back to the chat.",
    transferSchema,
    handleTransfer,
    { openWorld: true, meta: transferToolMeta },
  );

  register(
    "vcontinuity.file_picker",
    "Open File Picker",
    "Open the vContinuity file-import panel when the host has not already supplied a native file object.",
    z.object({}).strict(),
    async () => pickerResult(),
    { readOnly: true, journal: false, meta: pickerToolMeta },
  );

  register(
    "vcontinuity.health",
    "Runtime Health",
    "Return vContinuity version, capabilities, OAuth connection identity/scopes and runtime status without exposing token material.",
    z.object({ nonce: z.string().max(120).regex(/^[A-Za-z0-9_.:-]*$/).optional() }).strict(),
    async ({ nonce }, extra) => {
      const runtime = runtimeStatusProvider ? await runtimeStatusProvider() : null;
      const auth = extra?.http?.authInfo || null;
      return {
        ok: true,
        nonce: nonce || null,
        app: "vContinuity",
        version: VCONTINUITY_VERSION,
        webTools: VCONTINUITY_WEB_TOOL_NAMES.length,
        agentTools: 1,
        authenticated: Boolean(auth),
        clientId: auth?.clientId || null,
        connectionId: auth?.connectionId || null,
        grantedScopes: Array.isArray(auth?.scopes) ? auth.scopes : [],
        resource: auth?.resource || null,
        capabilities: {
          projectContext: true,
          filesystem: true,
          commands: true,
          jobs: true,
          git: true,
          transfer: true,
          workContext: true,
          computerUse: false,
          externalAgentRuntime: false,
        },
        workspaceRoots: config.workspaceRoots,
        runtime,
      };
    },
    { readOnly: true, journal: false },
  );

  return server;
}
