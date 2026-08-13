import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/mcp-server.js";

test("MCP server exposes the read-only catalogue contract", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer("test");
  const client = new Client({ name: "unified-agent-dev-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "unified_catalog_get",
        "unified_catalog_list",
        "unified_catalog_search",
        "unified_catalog_status",
        "unified_provider_list",
        "unified_resolve"
      ]
    );
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const status = await client.callTool({ name: "unified_catalog_status", arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as { counts: { catalogue: number } }).counts.catalogue, 100);

    const providers = await client.callTool({ name: "unified_provider_list", arguments: {} });
    assert.equal((providers.structuredContent as { count: number }).count, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("bundled offline MCP executable starts over stdio", async () => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(projectRoot, "runtime", "server.mjs"), "--host", "bundle-test"],
    stderr: "pipe"
  });
  const client = new Client({ name: "unified-agent-bundle-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const status = await client.callTool({ name: "unified_catalog_status", arguments: {} });
    assert.equal((status.structuredContent as { host: string }).host, "bundle-test");
  } finally {
    await client.close();
  }
});
