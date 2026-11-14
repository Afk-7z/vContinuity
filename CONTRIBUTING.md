# Contributing

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- Windows is the primary tested environment for v0.7.0

Install dependencies:

```powershell
npm ci
```

Run the validation suite with isolated temporary state:

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

The OAuth and browser checks start their own loopback runtime. The browser checks require a local Chromium, Chrome, or Edge; use `npx playwright-core install chromium` if none is available. Use `npm run doctor` to diagnose an installed instance separately.

## Project rules

- Keep the active implementation under `src/vcontinuity/`.
- Keep the MCP namespace under `vcontinuity.*`.
- Do not commit `data/`, `node_modules/`, machine-specific configuration, access tokens, grants, private hostnames, or user-specific filesystem paths.
- Add or update tests for behavior changes.
- Preserve the separation between the context-only Agent surface and the fuller Web surface.
- Computer Use is intentionally outside the v0.7.0 surface.
