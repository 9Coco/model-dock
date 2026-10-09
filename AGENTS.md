# ModelDock development

- Keep app logic in TypeScript and the UI in React. The gateway and credentials live in the main process, with a narrow preload bridge.
- Providers/accounts/models are global; tools consume references. Aggregate and subscription modes keep upstream secrets centralized. API direct mode may write the selected API Key only through explicit preview/export/apply actions; never export rotating OAuth tokens.
- Preserve localhost-only binding. Do not edit existing Agent or CPA configurations on startup; config application is an explicit user interface action with backups and validation.
- Never log credentials, request bodies, or OAuth token material. Do not check real tokens, SQLite files or fixture data directories into Git.
- Use meaningful mock-upstream tests for auth, routing, stream cancellation, OAuth rotation and configuration preservation. A model listing is not an inference test.
- Run `npm run typecheck`, `npm test`, `npm run build` for relevant changes. Inspect the Electron-rendered UI when changing layout. Record native Windows/Linux and live-provider verification separately.
- Keep the usual Windows directory delivery at `release/win-unpacked` current. If a running app requires a separate versioned build, report its exact path and only sync the usual directory after its processes have exited; never terminate the user's app just to replace a package.
- Supported tools are Codex, Claude Code, OpenCode, DSH, VS Code Copilot Chat, and GitHub Copilot desktop/SDK. Keep client-specific capability boundaries explicit; config serialization is not inference validation.

- Claude Code consumes one source at a time. Use known official Anthropic-compatible API endpoints with the existing provider key; use the localhost Messages bridge for account subscriptions and other compatible sources without exporting OAuth tokens. Reuse configured models, use upstream IDs for native calls and aliases for the bridge, honor CLAUDE_CONFIG_DIR, and preserve unrelated settings. Privacy controls default on but are not an OS sandbox; MCP and native usage import remain explicitly unsupported. Terminal configuration does not prove IDE extension configuration or real upstream acceptance.
