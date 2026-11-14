# Security Policy

## Security model

vContinuity connects an authorized Web AI client to a local machine. Treat access to the Web MCP as privileged local access.

The local MCP binds to `127.0.0.1`. The OAuth approval interface also binds locally. A public HTTPS reverse proxy or tunnel should expose only the OAuth-protected Web gateway.

Do **not** expose the local Agent MCP or the OAuth administration port directly to an untrusted network.

## Important capability boundaries

- `vcontinuity.fs_*` operations are restricted to configured workspace roots and reject symlink/junction escapes.
- `vcontinuity.git` operates from an authorized working directory.
- `vcontinuity.exec` and `vcontinuity.job` run arbitrary local processes with the permissions of the operating-system user running vContinuity.
- Workspace roots are **not an OS sandbox for commands**. A command granted through `commands:run` can potentially access resources outside those roots if the operating-system account itself can access them.
- File-transfer links are temporary capabilities and should be treated as sensitive until they expire.

Grant `commands:run` only to clients you trust to execute code as your local user.

## OAuth

The Web surface uses Authorization Code + PKCE S256, dynamic client registration, scoped bearer tokens, refresh-token rotation, revocation, and local approval.

Persistent token state stores token hashes rather than raw bearer tokens.

Supported scopes:

- `read`
- `files:read`
- `files:write`
- `commands:run`
- `works:read`
- `works:write`
- `git:read`
- `git:write`

## Local state

The `data/` directory contains runtime state such as OAuth grants, Work Context, jobs, and local receipts. It is intentionally excluded from Git.

The optional `vcontinuity.config.json` file is also excluded from Git because it commonly contains machine-specific paths.

## Reporting a vulnerability

Do not include access tokens, private OAuth state, filesystem contents, or other sensitive machine data in a public issue.

Before accepting external reports, enable GitHub Private Vulnerability Reporting or publish a private security contact.
