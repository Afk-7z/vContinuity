import { createRequire } from "node:module";
import { workBinding, workContextOp } from "./work-context.mjs";
import { VCONTINUITY_VERSION } from "./version.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

export const VCONTINUITY_WORKFLOW_INSTRUCTIONS = `Use shared Work Context automatically during substantive project implementation, debugging, investigation, and review unless the user opts out. Treat creating/updating the operational record as part of that project task; do not repeatedly ask for registration or checkpoint permission. A one-off lookup or merely reachable folder does not require registration.

At task start, call vcontinuity.work with action=list and the project root, reuse a matching active work, and resume it before changing files. If none exists, create one using the suggested ID and canonical project root, with the user's goal and a concrete next step. Avoid duplicate projects and do not reuse a closed task as active. When asked to finish a project by name, list works, identify it by title, goal and root, then resume its workId. Ask only if the target is materially ambiguous; do not require the user to retell recorded history.

After each meaningful edit/test milestone, decision, blocker, or change of direction, save a concise checkpoint: what changed, what was verified, and what comes next. Do not checkpoint every read, repeat unchanged notes, or wait for session end, quota exhaustion, or a user reminder. Save a handoff before a planned stop and compact before context pressure. Keep completed work, remaining steps and blockers explicit so a different client can continue toward a working deliverable. Use expectedRevision; on conflict, resume and reconcile instead of overwriting another client's work.

On resume, inspect localChanges and verification, read affected files, and re-run relevant checks when needed. Saved test notes are historical unless verification.status is recorded for the current workspace. Supply tests only for checks actually performed; omitting tests preserves historical evidence. Checkpoints do not expand the user's authorization. Store operational facts only, never secrets, credentials, private reasoning, or full conversations. If the service is unavailable, continue authorized work and report that continuity could not be saved; never claim a successful save. Filesystem comparison cannot recover unsaved intentions or native terminal output.`;

export const VCONTINUITY_AGENT_INSTRUCTIONS = `You are connected to the user's local workspace through vContinuity.

This Agent MCP surface exists only to preserve shared project/work context between local agents and web clients. Use your native filesystem, shell, Git, browser, process, and editing capabilities for actual local work.

${VCONTINUITY_WORKFLOW_INSTRUCTIONS}

When maintaining vContinuity itself, preserve user data, OAuth state, public endpoints, and rollback paths unless the task explicitly changes them. Validate affected behavior after edits.`;

export const workActions = [
  "create", "open", "resume", "list", "status", "history",
  "compact", "checkpoint", "update", "handoff", "close",
];

export const workSchema = z.object({
  action: z.enum(workActions),
  workId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
  title: z.string().max(300).optional(),
  goal: z.string().max(12000).optional(),
  root: z.string().max(32768).optional(),
  client: z.string().max(128).optional(),
  phase: z.string().max(100).optional(),
  summary: z.string().max(20000).optional(),
  latestSteering: z.string().max(12000).optional(),
  currentState: z.string().max(20000).optional(),
  completed: z.array(z.string().max(2000)).max(100).optional(),
  decisions: z.array(z.string().max(2000)).max(100).optional(),
  nextSteps: z.array(z.string().max(2000)).max(100).optional(),
  unresolved: z.array(z.string().max(2000)).max(100).optional(),
  filesChanged: z.array(z.string().max(2000)).max(100).optional(),
  tests: z.array(z.string().max(2000)).max(100).optional(),
  failures: z.array(z.string().max(2000)).max(100).optional(),
  doNotRedo: z.array(z.string().max(2000)).max(100).optional(),
  revalidate: z.array(z.string().max(2000)).max(100).optional(),
  outstanding: z.array(z.string().max(2000)).max(100).optional(),
  openQuestions: z.array(z.string().max(2000)).max(100).optional(),
  toClient: z.string().max(128).optional(),
  expectedRevision: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  historyLimit: z.number().int().min(1).max(200).optional(),
}).strict();

function toolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
}
function toolError(error) {
  const data = { ok: false, error: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: true };
}

export function createVContinuityAgentServer() {
  const server = new McpServer({
    name: "vcontinuity",
    title: "vContinuity",
    version: VCONTINUITY_VERSION,
    description: "vContinuity local-agent context surface.",
  }, { instructions: VCONTINUITY_AGENT_INSTRUCTIONS });

  server.registerTool("vcontinuity.work", {
    title: "Shared Work Context",
    description: "Use automatically for substantive project work: list by root (or find a project by title), create if missing, resume, and checkpoint meaningful progress without waiting for user reminders. Also inspect, compact, hand off, or close work. Use native tools for local operations.",
    inputSchema: workSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      if (!["list", "status"].includes(args.action) && !args.workId) {
        throw new Error("workId is required for action " + args.action);
      }
      return toolResult(await workContextOp(args, { surface: "agent", binding: workBinding(extra) }));
    } catch (error) {
      return toolError(error);
    }
  });
  return server;
}
