import { createRequire } from "node:module";
import { workBinding, workContextOp } from "./work-context.mjs";
import { VCONTINUITY_VERSION } from "./version.mjs";

const require = createRequire(import.meta.url);
const { McpServer } = require("@modelcontextprotocol/server");
const z = require("zod/v4");

export const VCONTINUITY_AGENT_INSTRUCTIONS = `You are connected to the user's local workspace through vContinuity.

This Agent MCP surface exists only to preserve shared project/work context between local agents and web clients. Use your native filesystem, shell, Git, browser, process, and editing capabilities for actual local work.

At the start of substantial project work, use vcontinuity.work with action=list and root set to the project directory. A reachable directory is not a registered Work Context. If it is unregistered, offer to register it in a lookup-only conversation; create a work only when registration is requested or clearly authorized by the task. Use the suggested ID and root as defaults. Resume the matching work before changing it. If a checkpoint is recommended, first verify what changed.

Checkpoint meaningful progress (changes, verification, blockers, and next steps), use expectedRevision to avoid overwriting another client's notes, and leave a checkpoint or handoff before ending substantial work. Compact before context pressure. Store operational context only: never store secrets, credentials, access tokens, hidden chain-of-thought, or private reasoning.

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
    description: "Find shared work with list and a project root; register it with create, resume it, or checkpoint verified progress. Also inspect, compact, hand off, or close work. Use native tools for local operations.",
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
