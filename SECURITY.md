# Security Policy

## Supported versions
Security fixes land on the latest release of `@rclabs/atom` (and the Atom Cloud / gateway Workers shipped in this repo).
Please upgrade with `npm i -g @rclabs/atom@latest`.

## Reporting a vulnerability
Please **do not** open a public issue. Report privately through
[GitHub private vulnerability reporting](https://github.com/chandrasekar-r/atom/security/advisories/new).
Include affected version, a description, reproduction steps and impact. You can expect an acknowledgement within
3 business days and a fix or mitigation plan within 14 days for high-severity issues. We're happy to credit reporters.

## Security model (summary)
- **Credentials** are stored in the OS keychain when available, otherwise in `~/.config/atom/` with mode 0600.
- **Permissions:** tools that change files, run commands or fetch URLs ask first unless you approve them (`auto` mode
  accepts file edits only; `--dangerously-skip-permissions` allows everything and should only be used in a sandbox).
- **Workspace trust:** project `.atom/` hooks, MCP servers, allow rules and plugins are ignored until you run `atom trust`.
- **Prompt injection:** content read from files and the web is untrusted; Atom asks before reading outside the project,
  before network fetches, and before running commands. Review prompts carefully when working with untrusted repositories.
- **Atom Cloud / gateway** run in *your* Cloudflare account; keep the gateway key long and random (`openssl rand -hex 32`).

## Scope
In scope: the CLI, `cloud/worker.js`, `gateway/worker.js`. Out of scope: model output quality, and issues that need
`--dangerously-skip-permissions` or a folder you explicitly trusted.
