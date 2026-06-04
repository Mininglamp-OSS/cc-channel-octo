# cc-channel-octo

Bridge [Claude Code](https://claude.ai/code) to [Octo](https://github.com/nicco-io/octo) IM via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

> Independent Node.js gateway — not an OpenClaw plugin.

## Status

🚧 Under development (v0.1 MVP)

## Quick Start

```bash
npm install
cp config.example.json config.json
# Edit config.json with your bot token and API URL
npm run build
npm start
```

## Configuration

See [config.example.json](./config.example.json) for all options.

Environment variables (`CC_OCTO_*`) override config.json values. See `src/config.ts` for the full mapping.

## Security Model

cc-channel-octo runs in **headless automation mode** by default:

- `permissionMode: "bypassPermissions"` — required for headless operation. Without this, Claude Code would prompt for confirmation and hang (no terminal to answer).
- `allowDangerouslySkipPermissions: true` — automatically set when `permissionMode` is `bypassPermissions`.
- Security is enforced via the **`allowedTools` whitelist**, not via permission prompts.

### ⚠️ Critical: Isolate your `cwd`

**`cwd` must point to an isolated working directory** that does NOT contain:
- `config.json` (contains your bot token)
- Private keys, credentials, or secrets
- Sensitive configuration files

Any Octo user who can message the bot can instruct Claude Code to read files in `cwd`. Ensure `cwd` contains only the project code you want the bot to work with.

### Reducing attack surface

The default `allowedTools` includes the full tool set for maximum automation capability. To reduce risk:

- **Remove network tools**: Drop `WebFetch` and `WebSearch` from `allowedTools` to eliminate SSRF risk.
- **Read-only mode**: Set `allowedTools` to `["Read", "Glob", "Grep"]` to restrict the bot to code reading only.
- **No shell access**: Remove `Bash` to prevent arbitrary command execution.

Example safe-mode config:
```json
{
  "sdk": {
    "allowedTools": ["Read", "Glob", "Grep"],
    "permissionMode": "bypassPermissions"
  }
}
```

### Built-in system prompt

A default system prompt warns Claude that input comes from untrusted IM users and instructs it to decline requests for sensitive file reads or data exfiltration. This is a **soft constraint** (model-level guidance), not a security boundary. The `allowedTools` whitelist and `cwd` isolation are the real security controls.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## Known Limitations (v0.1)

- Text messages only (no image/file support)
- All users share one `cwd` (no per-session isolation)
- v1 `query()` API — workspace state does not persist across messages
- Single bot per process

## License

Apache-2.0
