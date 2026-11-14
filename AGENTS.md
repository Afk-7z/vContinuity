# vContinuity — project instructions (v0.7.0)

## Scope

vContinuity is a vendor-agnostic local bridge between authorized Web AI clients and a user's computer. It also shares operational project context with local agents.

Do not introduce dependencies on specific model vendors, external agent runtimes, third-party memory systems, or product-specific tool namespaces.

Computer Use is intentionally outside v0.7.0.

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
