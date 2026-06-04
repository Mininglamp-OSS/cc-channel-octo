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

### Security Profiles

**Safe mode** (read-only tools, minimal risk):
```json
{
  "sdk": {
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "WebSearch"],
    "permissionMode": "bypassPermissions"
  }
}
```

**Full mode** (all tools — understand the risks):
```json
{
  "sdk": {
    "allowedTools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
    "permissionMode": "bypassPermissions"
  }
}
```

⚠️ `bypassPermissions + Bash` = the bot can execute arbitrary commands. Deploy responsibly.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design document.

## Known Limitations (v0.1)

- Text messages only (no image/file support)
- All users share one `cwd` (no per-session isolation)
- v1 `query()` API — workspace state does not persist across messages
- Single bot per process

## License

Apache-2.0
