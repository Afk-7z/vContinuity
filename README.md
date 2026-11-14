# vContinuity

**English** · [Português (Brasil)](README.pt-BR.md)

vContinuity is a local MCP bridge that lets an authorized Web AI client work with a user's computer and share project context with local agents, without depending on a specific model vendor or external agent runtime.

Current version: **0.7.0 (preview)**. Windows is the primary tested platform.

For example, a Web client can make a change and save a checkpoint with the result and the next steps. Later, a local agent can resume from that checkpoint and use its own editor and terminal. You can review or update the same record in the local dashboard.

## What it provides

vContinuity exposes two MCP surfaces:

- **Agent MCP** — local, context-only: `vcontinuity.work`
- **Web MCP** — local execution and project bridge: 13 `vcontinuity.*` tools

The Web surface includes project context, filesystem read/write/search/patch, foreground execution, persistent jobs, Git operations, file transfer, shared Work Context, and runtime health.

Computer Use is intentionally not part of v0.7.0.

## Requirements

- Node.js 22 or newer
- npm
- Git to clone the repository and use Git tools; ripgrep (`rg`) for file search
- Windows is the primary tested environment for this release
- An HTTPS reverse proxy or tunnel if a remote Web client must reach the OAuth-protected gateway

## Install

```powershell
git clone https://github.com/Afk-7z/vContinuity.git
cd vContinuity
npm ci
```

### Local workspace configuration

A machine-specific config is optional. Without one, vContinuity authorizes the project root plus the current user's Documents, Projects, Downloads, and Desktop directories.

For a restrictive starting point:

```powershell
Copy-Item .\vcontinuity.config.example.json .\vcontinuity.config.json
```

Then edit `vcontinuity.config.json` as needed. This file is ignored by Git.

You can also point to another config file with:

```powershell
$env:VCONTINUITY_CONFIG = "C:\path\to\config.json"
```

### Start locally

For the dashboard and local MCP, use a placeholder HTTPS origin. It satisfies the runtime configuration without requiring a tunnel or making the service reachable from the internet:

```powershell
$env:VCONTINUITY_PUBLIC_ORIGIN = "https://vcontinuity.example.test"
npm start
```

Open the [local dashboard](http://127.0.0.1:7783/) or check [service health](http://127.0.0.1:7781/healthz). Start the service from the repository directory so the relative paths in the sample config resolve there.

### Remote Web access (optional)

Create the local OAuth config:

```powershell
New-Item -ItemType Directory -Force .\data\oauth | Out-Null
Copy-Item .\oauth.config.example.json .\data\oauth\config.json
```

Edit `publicOrigin` so it matches the HTTPS origin that forwards to the local OAuth/Web gateway on port `7791`. In the same shell, remove the local-only environment override with `Remove-Item Env:VCONTINUITY_PUBLIC_ORIGIN -ErrorAction SilentlyContinue` before restarting: the environment variable takes precedence over the file.

Alternatively:

```powershell
$env:VCONTINUITY_PUBLIC_ORIGIN = "https://your-public-host.example.com"
```

Point a compatible remote MCP client to `https://your-public-host.example.com/mcp/web`. When it requests access, review the client and requested permissions in the local dashboard, approve only the scopes it needs, and return to the client to finish authorization. Revoke the connection in the dashboard when it no longer needs access.

Optional environment variables:

- `VCONTINUITY_PUBLIC_GATEWAY_PORT` — default `7791`
- `VCONTINUITY_ADMIN_PORT` — default `7783`
- `VCONTINUITY_RESOURCE_PATH` — default `/mcp/web`
- `VCONTINUITY_OAUTH_CONFIG` — alternate OAuth config path
- `VCONTINUITY_OAUTH_STORAGE_ROOT` — alternate OAuth state directory
- `VCONTINUITY_PORT` — local MCP port, default `7781`
- `VCONTINUITY_DATA_ROOT` — alternate state root for Work Context, jobs, job archives, and the default OAuth storage; defaults to `data/`

## Start

```powershell
npm start
```

Default local endpoints:

- Web MCP: `http://127.0.0.1:7781/mcp/web`
- Agent MCP: `http://127.0.0.1:7781/mcp/agent`
- OAuth/Web gateway: `http://127.0.0.1:7791`
- Local Control Dashboard & OAuth approval UI: `http://127.0.0.1:7783/`
- Health: `http://127.0.0.1:7781/healthz`

The public HTTPS origin should forward the OAuth/Web gateway. Do not expose ports `7781` or `7783` directly to an untrusted network.

A portable Windows launcher is available at:

```text
bin\vcontinuity-unified.cmd
```

For startup automation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-vcontinuity-on-windows-login.ps1
```

## Web MCP tools

| Tool | Purpose |
| --- | --- |
| `vcontinuity.project` | Authorized roots and project instructions |
| `vcontinuity.work` | Shared persistent Work Context |
| `vcontinuity.fs_list` | Bounded directory listing |
| `vcontinuity.fs_read` | UTF-8 file reads with hashes |
| `vcontinuity.fs_search` | Text/file search with ripgrep |
| `vcontinuity.fs_patch` | Exact atomic patching |
| `vcontinuity.fs_write` | Controlled file writes |
| `vcontinuity.exec` | Foreground command execution |
| `vcontinuity.job` | Persistent background jobs |
| `vcontinuity.git` | Status, diff, log, branches, worktrees |
| `vcontinuity.transfer` | Import/export files |
| `vcontinuity.file_picker` | Native import picker |
| `vcontinuity.health` | Runtime/OAuth/capability status |

The Agent MCP exposes only `vcontinuity.work`; local agents are expected to use their own native filesystem, shell, Git, browser, process, and editing capabilities.

## Continue a project

Open the local dashboard and use **Find a project by folder** in the Continuity tab. An authorized folder can be accessed even when it has no Work Context. The dashboard and `vcontinuity.project` report whether to register it, resume it, or review it for a checkpoint. The Agent surface can find the same information with `vcontinuity.work` (`action: "list"`, `root: "<project-directory>"`). A lookup does not register a project.

A checkpoint is recommended after recorded activity beyond the latest summary or after seven days without an update. Review what actually changed, then save a checkpoint with the current state, tests, items to revalidate, and next steps. Resume selects the latest available summary by revision and time and includes recent activity recorded after it. The dashboard keeps an unsaved draft while you switch views, warns about intervening changes, and lets you compare saved checkpoints.

For MCP clients, the typical sequence is `list` with the project root → `create` if needed or `resume` an existing work → `checkpoint`. Use the current `workId` and `expectedRevision` when saving to detect concurrent edits. The activity log helps locate changes; a checkpoint is where you record what was verified and what still needs doing. Keep credentials and private reasoning out of the record.

Both MCP surfaces instruct clients to perform that sequence automatically during substantive project work: reuse or create the project record, save progress after meaningful milestones, and resume a named project when asked to finish it. Registration and checkpoint updates do not require repeated reminders. Simple lookups remain read-only; user opt-outs and authorization boundaries still apply. These are agent workflow instructions, not a filesystem watcher or a guarantee that every client follows them. The client needs an active MCP connection with the necessary permissions, and the local service/computer must remain reachable. Reconnect clients after restarting an updated service to refresh its instructions.

To switch clients after an abrupt interruption, resume the same work from the Web client. Work creation and semantic updates automatically save a bounded Git workspace baseline: HEAD, index metadata and content hashes of tracked and non-ignored untracked files. Resume compares current files against that baseline, including files that were already dirty, and returns `localChanges`, affected paths, and checkpoint guidance. File contents and diffs are not stored. No final handoff is required to detect subsequent disk changes.

Save small checkpoints after meaningful edit/test milestones: what changed, what was verified, next step. Tests are agent-reported evidence: `verification.status: "recorded"` means the recorded evidence matches the sampled workspace, not that vContinuity ran the tests. Changed files require revalidation; saving a checkpoint without new `tests` does not refresh old evidence. Compaction preserves the workspace baseline. The dashboard distinguishes historical test notes from evidence associated with the current files.

Limits: this does not recover unsaved editor buffers, intentions, or native terminal output. Git must be installed. Missing baselines, non-Git folders, unsupported paths (including symlinks/submodules), read failures, and scan limits produce unknown freshness and review guidance. Each scan is capped at 5,000 paths and 64 MiB of file content, with bounded subprocess and read time. Ignored untracked files and vContinuity state directories are excluded. Sampling is not an atomic filesystem snapshot; stop concurrent writers for a reliable handoff. No vendor-specific runtime or automatic test execution is added.

The active work is separate for each OAuth connection, and for each session when the MCP client provides a session identifier. For stateless clients that support request metadata, use `params._meta["vcontinuity/session"]` consistently on every tool request to separate sessions within the same connection or local surface. Without a session identifier, the defaults are per OAuth connection or per local surface. This controls active selection and journal attribution; stored Work Context remains shared. For existing installations, resume a work once per OAuth connection to establish its new active selection.

The dashboard previews cleanup before applying it. Finished jobs and their logs can be archived to `jobs-archive/` under the state root and restored by archive ID. OAuth cleanup removes eligible revoked or expired records and keeps client registrations and authorizations in progress.

## OAuth scopes

The Web gateway supports:

- `read`
- `files:read`
- `files:write`
- `commands:run`
- `works:read`
- `works:write`
- `git:read`
- `git:write`

OAuth uses Authorization Code + PKCE S256, refresh-token rotation, dynamic client registration, local approval/revocation, and token hashes at rest.

## Validation

Run `npm run doctor` to diagnose the installed instance without changing it. It checks the local executables, configuration, state, and listeners.

The checks below run with temporary state. The integration checks start a separate loopback runtime, so they do not require a public endpoint or a live OAuth connection:

```powershell
npm run check
npm test
npm run verify:surface
npm run verify:agent
npm run verify:parity
npm run verify:oauth
npm run verify:oauth:security
npm run test:browser
npm run audit:public
```

The browser tests use an installed Chromium, Chrome, or Edge, or the Playwright Chromium build (`npx playwright-core install chromium`). Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use a specific executable.

## Security

`vcontinuity.exec` and `vcontinuity.job` are powerful: granting `commands:run` allows arbitrary local process execution as the operating-system user running vContinuity. Workspace roots restrict the dedicated filesystem tools, but they are not an OS sandbox for arbitrary commands.

Read [SECURITY.md](SECURITY.md) before exposing the Web gateway.

## Repository hygiene

Local runtime state is intentionally excluded from Git:

- `data/`
- `node_modules/`
- `vcontinuity.config.json`
- `.env*`
- logs and local-only JSON overrides

Run `npm run audit:public` before publishing changes.

## License

Apache-2.0. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
