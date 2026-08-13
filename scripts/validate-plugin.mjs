import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function json(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function mustExist(path) {
  const info = await stat(resolve(root, path));
  if (!info.isFile()) throw new Error(`${path} must be a file`);
}

const codex = await json("plugins/unified-agent-dev/.codex-plugin/plugin.json");
if (codex.name !== "unified-agent-dev" || codex.version !== "0.1.0") {
  throw new Error("Codex plugin identity/version mismatch");
}
if (codex.mcpServers !== "./.mcp.json" || codex.skills !== "./skills/") {
  throw new Error("Codex plugin must declare its MCP and skills directories");
}
const codexMcp = await json("plugins/unified-agent-dev/.mcp.json");
const codexServer = codexMcp?.mcpServers?.["unified-agent-dev"];
if (codexServer?.command !== "node" || !codexServer?.args?.includes("./runtime/server.mjs")) {
  throw new Error("Codex MCP server descriptor is incomplete");
}

const claude = await json("adapters/claude-plugin/.claude-plugin/plugin.json");
if (claude.name !== "unified-agent-dev" || claude.version !== codex.version) {
  throw new Error("Claude plugin identity/version mismatch");
}
if (claude.skills !== "./skills/") throw new Error("Claude plugin must declare the shared routing skill");
const claudeMcp = await json("adapters/claude-plugin/.mcp.json");
if (!claudeMcp?.["unified-agent-dev"]?.args?.[0]?.includes("CLAUDE_PLUGIN_ROOT")) {
  throw new Error("Claude MCP descriptor must resolve inside the copied plugin root");
}

for (const marketplacePath of [
  "marketplaces/codex/.agents/plugins/marketplace.json",
  "marketplaces/claude/.claude-plugin/marketplace.json"
]) {
  const marketplace = await json(marketplacePath);
  if (marketplace.name !== "unified-agent-dev-local" || marketplace.plugins?.length !== 1) {
    throw new Error(`${marketplacePath} must expose exactly one unified plugin`);
  }
}
await mustExist("plugins/unified-agent-dev/skills/unified-agent-dev/SKILL.md");
await mustExist("plugins/unified-agent-dev/runtime/server.mjs");
await mustExist("adapters/claude-plugin/runtime/server.mjs");
await mustExist("adapters/claude-plugin/skills/unified-agent-dev/SKILL.md");
await mustExist("adapters/opencode/skills/unified-agent-dev/SKILL.md");
process.stdout.write("Validated Codex, Claude Code, and OpenCode adapter layouts\n");
