# Support

## Current scope

Unified Agent Dev `0.1.0` supports local development evaluation on Windows with Node.js `22.14.0` or newer and one or more of these hosts:

- Codex
- Claude Code
- OpenCode

The supported product surface is the shared catalogue, MCP server, native host adapters, transactional installer, integrity doctor, and rollback workflow. The 100 upstream catalogue entries are research metadata and are not individually supported or executable in this release.

## Getting help

Before opening an issue, run:

```powershell
unified-agent-dev doctor
unified-agent-dev catalog status
```

Open a GitHub issue at:

https://github.com/mahmoud20138/Unified-Agent-Dev/issues

Include the product version, Windows version, Node.js version, affected host CLI and version, the redacted doctor output, and reproducible steps. Never attach API keys, tokens, complete user configuration files, or other secrets.

Security issues must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.
