# vContinuity — project instructions (v0.7.0)

## Scope

vContinuity is a vendor-agnostic local bridge between authorized Web AI clients and a user's computer. It also shares operational project context with local agents.

Do not introduce dependencies on specific model vendors, external agent runtimes, third-party memory systems, or product-specific tool namespaces.

Computer Use is intentionally outside v0.7.0.

## Automatic project continuity

Use the available vContinuity Work Context MCP automatically for substantive implementation, debugging, investigation, and review, unless the user opts out. At task start, list works for the project root, reuse and resume a matching active work, or create the missing record with the user's goal. Registration and operational updates are part of the authorized project task; do not repeatedly ask permission. A one-off lookup does not register a project.

When asked to finish a project by name, find its title/root in the work list and resume it. Inspect current files and verification before acting; ask only if the project identity is ambiguous. Save a short checkpoint after meaningful changes, tests, decisions, blockers, or steering: what changed, what was verified, next step. Do not wait for quota exhaustion or session end, and do not save after every read. Use expectedRevision and reconcile conflicts. Record partial working results and remaining steps for another client. Never copy secrets, private reasoning, or full conversations into context, and never report an unconfirmed save as successful. Continue authorized work if the service is unavailable and report the continuity limitation.

## MCP surfaces

- `/mcp/agent`: exactly one tool, `vcontinuity.work`.
- `/mcp/web`: exactly 13 tools under `vcontinuity.*`.
- `/mcp`: local compatibility alias for `/mcp/web`.
- The public route must never expose `/mcp/agent`.

## Active architecture

- Runtime: `src/vcontinuity/unified-http.mjs`
- Optional local config: `vcontinuity.config.json` (ignored by Git)
- Public config example: `vcontinuity.config.example.json`
- OAuth config: `data/oauth/config.json` or environment variables
- MCP local port: 7781 by default
- OAuth/Web gateway: 7791 by default
- Local OAuth approval: 7783 by default
- Work Context: `data/works/`
- Jobs: `data/jobs/`

## Repository hygiene

Never commit:

- `data/`
- `node_modules/`
- `vcontinuity.config.json`
- user-specific absolute paths
- private/public tunnel hostnames tied to one machine
- OAuth connection IDs, tokens, grants, credentials, or private keys

Use examples/placeholders for documentation and public config.

## Change rules

1. Use only active modules under `src/vcontinuity/`.
2. Preserve the Agent/Web separation.
3. Validate affected behavior after edits.
4. Keep the exact public tool contract unless the task explicitly changes it.
5. Never store secrets or private reasoning in Work Context.
6. Run `npm run audit:public` before a public commit.

## Validation

```powershell
npm run check
npm test
npm run verify:surface
npm run verify:agent
npm run audit:public
```

OAuth integration checks additionally require a configured/running runtime:

```powershell
npm run verify:parity
npm run verify:oauth
npm run verify:oauth:security
```
