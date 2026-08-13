# Unified Agent Dev

Unified Agent Dev is a Windows-first catalogue gateway for Codex, Claude Code, and OpenCode. One shared MCP server and routing skill expose a normalized 100-entry AI-agent research catalogue through native adapters for all three hosts.

> [!IMPORTANT]
> Version `0.1.0` is an **unsigned development release**. It contains 100 searchable catalogue records and **0 accepted executable providers**. It does not download, install, or run any of the 100 upstream candidates.

## What it does

- Searches and filters 100 normalized research entries covering skills, plugins, MCP servers, agent tools, catalogues, and security/build utilities.
- Installs one shared read-only MCP catalogue into detected Codex, Claude Code, and OpenCode hosts.
- Keeps research discovery separate from executable-provider admission.
- Fails closed when a matching entry has not passed immutable source, license, security, Windows, isolation, and permission gates.
- Installs transactionally and can restore managed host configuration with rollback.

## What it contains

| Path | Contents |
| --- | --- |
| `catalog/catalog.json` | Public normalized projection of all 100 research entries. |
| `catalog/providers.runtime.json` | Executable-provider projection. It is empty in `0.1.0`. |
| `runtime/server.mjs` | Bundled offline MCP catalogue server generated during the build. |
| `runtime/cli.mjs` | Self-contained installer, catalogue, doctor, and rollback CLI generated during the build. |
| `plugins/unified-agent-dev/` | Native Codex plugin descriptor and shared routing skill. |
| `adapters/claude-plugin/` | Native Claude Code plugin descriptor and shared routing skill. |
| `adapters/opencode/` | OpenCode skill and configuration integration. |
| `marketplaces/` | Local Codex and Claude marketplace descriptors used by the installer. |
| `src/` | TypeScript catalogue, MCP, integrity, installer, and CLI implementation. |
| `scripts/` | Catalogue admission compiler, release builder, and structural adapter validator. |
| `tests/` | Catalogue, admission, MCP, Windows transaction, integrity, and rollback tests. |
| `release/release.manifest.json` | Generated manifest covering the exact installable release file set. |
| `providers/` | Admission evidence location for future approved providers. No provider is approved yet. |

The MCP server exposes six read-only tools:

- `unified_catalog_status`
- `unified_catalog_list`
- `unified_catalog_search`
- `unified_catalog_get`
- `unified_provider_list`
- `unified_resolve`

## Requirements

- Windows 10 or Windows 11
- Node.js `22.14.0` or newer
- npm `11` or newer
- At least one supported host CLI: Codex, Claude Code, or OpenCode

The installer auto-detects installed hosts. You can also select hosts explicitly.

## Install from the repository

This is the recommended installation path while `0.1.0` remains an unsigned development build.

```powershell
git clone https://github.com/mahmoud20138/Unified-Agent-Dev.git
cd unified-agent-dev
npm ci --ignore-scripts
npm run build
npm run plugin:validate
```

Inspect the complete read-only preflight:

```powershell
.\Install-UnifiedAgentDev.ps1 -DryRun
```

Install into every detected supported host:

```powershell
.\Install-UnifiedAgentDev.ps1
```

Or install only selected adapters:

```powershell
.\Install-UnifiedAgentDev.ps1 -Agents "codex,claude"
```

The PowerShell wrapper verifies the generated development release and passes the explicit unsigned-development authorization. It then performs one transactional installation across the selected hosts.

## Build and install a local package

To test the same one-install package shape used for a future release:

```powershell
npm run pack:release
Get-FileHash .\unified-agent-dev-cli-0.1.0.tgz -Algorithm SHA256
npm install --global .\unified-agent-dev-cli-0.1.0.tgz
unified-agent-dev install --agents auto --allow-unsigned-development
```

The `--allow-unsigned-development` flag is mandatory for `0.1.0`. A future public release must use a publisher-signed manifest and must not require this flag.

## Verify the installation

```powershell
unified-agent-dev doctor
unified-agent-dev catalog status
```

For `0.1.0`, the expected state is:

- `healthy: true`
- 24 integrity-locked generated release files
- `catalogue: 100`
- `accepted: 0`
- `catalogOnly: 100`

The installed runtime remains self-managing if the cloned repository is moved or removed:

```powershell
node "$env:USERPROFILE\.unified-agent-dev\releases\0.1.0\runtime\cli.mjs" doctor
```

## Use the catalogue

```powershell
unified-agent-dev catalog status
unified-agent-dev catalog list --limit 20
unified-agent-dev catalog search "browser automation" --agent codex
unified-agent-dev resolve "database tools"
unified-agent-dev mcp --host codex
```

`resolve` can return research matches, but it cannot route an entry unless that exact provider appears in `catalog/providers.runtime.json`.

## Roll back or uninstall

The installer records each committed installation as a transaction. These commands reverse the latest committed transaction and restore the configuration it replaced:

```powershell
unified-agent-dev rollback
# equivalent alias
unified-agent-dev uninstall
```

If the npm package was installed globally, remove the CLI package after rollback:

```powershell
npm uninstall --global @unified-agent-dev/cli
```

After repeated installs, one rollback restores the immediately preceding transaction; it does not necessarily erase every older installation transaction.

## Development

Run the complete Windows validation gate:

```powershell
npm ci --ignore-scripts
npm run check
```

`npm run check` compiles the 100-entry catalogue, type-checks the TypeScript core, bundles the offline runtimes, runs 11 tests, validates the three adapter layouts, and checks the npm package contents. When supported host CLIs are installed, the Windows shim test probes their real executables; absent host CLIs are skipped.

## Security and admission boundary

Catalogue membership never grants execution rights. A candidate can enter the runtime registry only when its exact artifact is bound to:

- an immutable Git commit or exact npm package lock;
- redistributable license evidence;
- a current security review and artifact digest;
- explicit Windows architecture/runtime evidence;
- a least-privilege permission and destructive-action contract; and
- an approved runtime role with enforceable isolation.

See [SECURITY.md](SECURITY.md) for vulnerability reporting and [SUPPORT.md](SUPPORT.md) for support scope.

## Release status and license

Unified Agent Dev is licensed under the [MIT License](LICENSE). Catalogue entries describe independent upstream projects; each upstream project retains its own license and is not redistributed by `0.1.0`.

The unsigned `0.1.0` tarball is for local development validation, not a signed public release. A supported public binary release still requires a publisher-owned signing key, support/privacy/terms identity, signed release assets, and at least one provider with complete acceptance evidence.
