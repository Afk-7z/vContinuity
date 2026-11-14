import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileTransferService } from "./file-transfer-service.mjs";

const z = createRequire(import.meta.url)("zod/v4");
const html = readFileSync(new URL("./file-transfer-ui.html", import.meta.url), "utf8");

export const TRANSFER_UI_URI = "ui://vcontinuity/files-" + createHash("sha256").update(html).digest("hex").slice(0, 16) + ".html";

const csp = {
  connectDomains: ["https://*.trycloudflare.com"],
  resourceDomains: ["https://*.trycloudflare.com"],
};
const resourceMeta = {
  ui: { csp, prefersBorder: true },
  "openai/widgetDescription": "Importar arquivos do ChatGPT para o computador local via vContinuity.",
  "openai/widgetCSP": { connect_domains: csp.connectDomains, resource_domains: csp.resourceDomains },
  "openai/widgetPrefersBorder": true,
};

export const nativeFileSchema = z.object({
  download_url: z.string(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

export const transferSchema = z.object({
  action: z.enum(["workflow", "import", "import_status", "export"]),
  file: nativeFileSchema.optional(),
  filename: z.string().max(260).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  importId: z.string().max(128).optional(),
  path: z.string().max(32768).optional(),
  ttlSeconds: z.number().int().min(60).max(1800).optional(),
}).strict();

export function registerTransferResource(server) {
  server.registerResource(
    "vcontinuity-files",
    TRANSFER_UI_URI,
    { mimeType: "text/html;profile=mcp-app", _meta: resourceMeta },
    async () => ({
      contents: [{
        uri: TRANSFER_UI_URI,
        mimeType: "text/html;profile=mcp-app",
        text: html,
        _meta: resourceMeta,
      }],
    }),
  );
}

export async function handleTransfer(args) {
  const action = args.action;
  if (action === "workflow") return fileTransferService.workflow();
  if (action === "import") {
    if (!args.file) throw new Error("file is required for action=import");
    return fileTransferService.startImport({
      file: args.file,
      filename: args.filename || "",
      sha256_hex: args.sha256 || "",
    });
  }
  if (action === "import_status") {
    if (!args.importId) throw new Error("importId is required for action=import_status");
    return fileTransferService.status(args.importId);
  }
  if (action === "export") {
    if (!args.path) throw new Error("path is required for action=export");
    const result = await fileTransferService.prepareDelivery(args.path, args.sha256 || "", args.ttlSeconds || 900);
    return {
      __mcpResult: true,
      content: [{
        type: "resource_link",
        uri: result.download_url,
        name: result.filename,
        mimeType: result.mime_type,
        size: result.bytes,
        description: "Verified local file exported by vContinuity; download before expiration.",
      }],
      structuredContent: result,
    };
  }
  throw new Error("Unsupported transfer action: " + action);
}

export function pickerResult() {
  return {
    ok: true,
    mode: "import",
    state: "awaiting_user_selection",
    resource_uri: TRANSFER_UI_URI,
  };
}

export const transferToolMeta = {
  ui: { visibility: ["model", "app"] },
  "openai/widgetAccessible": true,
  "openai/fileParams": ["file"],
};

export const pickerToolMeta = {
  ui: { resourceUri: TRANSFER_UI_URI, visibility: ["model", "app"] },
  "openai/widgetAccessible": true,
  "openai/outputTemplate": TRANSFER_UI_URI,
};

export async function closeTransfer() {
  await fileTransferService.close().catch(() => {});
}
