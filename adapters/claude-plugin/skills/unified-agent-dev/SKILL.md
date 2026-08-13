---
name: unified-agent-dev
description: Search the unified 100-source AI-agent catalogue and choose only release-approved providers. Use when the user asks what agent skill, plugin, MCP server, or developer tool is available across the catalogue.
---

# Unified Agent Dev

<!-- managed-by: unified-agent-dev -->

Use the `unified_catalog_*` MCP tools to inspect research metadata. Use `unified_resolve` when the user asks for a capability and `unified_provider_list` when they ask what can actually run.

Treat catalogue membership and provider acceptance as separate facts:

- `catalog-only`, `reference-only`, and `quarantined` entries are informational. Never download or execute them.
- Only `accepted` entries may be selected as runtime providers.
- If resolution returns `catalog-only`, explain that matching research exists but no provider passed the release gates.
- Do not broaden permissions, authenticate a remote service, or perform destructive work on behalf of a fallback provider.

The plugin is Windows-first. Do not claim another operating system is supported by release 0.1.0.
