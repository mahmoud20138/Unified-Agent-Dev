#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import {
  listResources,
  loadCatalog,
  loadRuntimeRegistry,
  resolveCapability,
  searchResources
} from "./catalog.js";
import type { ReleaseState } from "./types.js";

const VERSION = "0.1.0";
const releaseStates = ["accepted", "catalog-only", "quarantined", "reference-only"] as const;

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {})
  };
}

export function createServer(host = process.env.UNIFIED_AGENT_HOST ?? "unknown"): McpServer {
  const server = new McpServer({ name: "unified-agent-dev", version: VERSION });
  const readOnly = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };

  server.registerTool(
    "unified_catalog_status",
    {
      title: "Unified catalogue status",
      description: "Report the 100-entry research catalogue and accepted-provider counts.",
      inputSchema: {},
      annotations: readOnly
    },
    async () => {
      const catalog = await loadCatalog();
      return result({
        host,
        version: VERSION,
        architecture: catalog.architecture,
        counts: catalog.counts,
        sourceSha256: catalog.sourceSha256,
        executionPolicy: "Only releaseState=accepted can be routed. Catalogue inclusion never grants execution."
      });
    }
  );

  server.registerTool(
    "unified_catalog_search",
    {
      title: "Search unified catalogue",
      description: "Search the 100 normalized research entries without installing or executing them.",
      inputSchema: {
        query: z.string().min(1),
        agent: z.string().min(1).optional(),
        releaseState: z.enum(releaseStates).optional(),
        limit: z.number().int().min(1).max(50).default(10)
      },
      annotations: readOnly
    },
    async ({ query, agent, releaseState, limit }) => {
      const matches = await searchResources(query, {
        ...(agent ? { agent } : {}),
        ...(releaseState ? { releaseState: releaseState as ReleaseState } : {}),
        limit
      });
      return result({ query, count: matches.length, matches });
    }
  );

  server.registerTool(
    "unified_catalog_list",
    {
      title: "List unified catalogue",
      description: "List normalized catalogue metadata, optionally filtered by agent or release state.",
      inputSchema: {
        agent: z.string().min(1).optional(),
        releaseState: z.enum(releaseStates).optional(),
        limit: z.number().int().min(1).max(100).default(100)
      },
      annotations: readOnly
    },
    async ({ agent, releaseState, limit }) => {
      const resources = await listResources({
        ...(agent ? { agent } : {}),
        ...(releaseState ? { releaseState: releaseState as ReleaseState } : {}),
        limit
      });
      return result({ count: resources.length, resources });
    }
  );

  server.registerTool(
    "unified_catalog_get",
    {
      title: "Get catalogue entry",
      description: "Get one normalized catalogue entry by its integer catalogue ID.",
      inputSchema: { catalogId: z.number().int().min(1).max(100) },
      annotations: readOnly
    },
    async ({ catalogId }) => {
      const catalog = await loadCatalog();
      const resource = catalog.resources.find((candidate) => candidate.catalogId === catalogId);
      return resource
        ? result({ resource })
        : result({ error: `Catalogue entry ${catalogId} does not exist.` }, true);
    }
  );

  server.registerTool(
    "unified_resolve",
    {
      title: "Resolve an accepted capability",
      description: "Resolve a request to an accepted provider. Fails closed when matches are research-only.",
      inputSchema: { query: z.string().min(1) },
      annotations: readOnly
    },
    async ({ query }) => result(await resolveCapability(query))
  );

  server.registerTool(
    "unified_provider_list",
    {
      title: "List accepted providers",
      description: "List only providers that passed immutable source, license, security, and Windows gates.",
      inputSchema: {},
      annotations: readOnly
    },
    async () => {
      const providers = (await loadRuntimeRegistry()).providers;
      return result({ count: providers.length, providers });
    }
  );

  return server;
}

export async function runStdioServer(host?: string): Promise<void> {
  const server = createServer(host);
  await server.connect(new StdioServerTransport());
}

const isEntryPoint = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]!);
if (isEntryPoint) {
  const hostIndex = process.argv.indexOf("--host");
  const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : undefined;
  runStdioServer(host).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
