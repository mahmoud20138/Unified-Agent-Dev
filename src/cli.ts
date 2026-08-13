#!/usr/bin/env node
import { listResources, loadCatalog, resolveCapability, searchResources } from "./catalog.js";
import { doctorProduct, installProduct, rollbackLast, type Host } from "./installer.js";
import { runStdioServer } from "./mcp-server.js";
import type { ReleaseState, SearchOptions } from "./types.js";

const usage = `Unified Agent Dev 0.1.0

Usage:
  unified-agent-dev catalog status
  unified-agent-dev catalog list [--state STATE] [--agent AGENT] [--limit N]
  unified-agent-dev catalog search <query> [--state STATE] [--agent AGENT] [--limit N]
  unified-agent-dev resolve <query>
  unified-agent-dev mcp [--host codex|claude|opencode]
  unified-agent-dev install [--agents auto|codex,claude,opencode] [--home PATH] [--dry-run]
                            [--skip-host-commands] [--allow-unsigned-development]
  unified-agent-dev doctor [--home PATH]
  unified-agent-dev rollback [--home PATH]

The 100 catalogue entries are metadata. Only accepted providers can be routed.`;

function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function limit(args: string[]): number {
  const raw = value(args, "--limit");
  if (!raw) return 100;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error("--limit must be an integer from 1 to 100");
  return parsed;
}

function state(args: string[]): ReleaseState | undefined {
  const raw = value(args, "--state");
  if (!raw) return undefined;
  if (!["accepted", "catalog-only", "quarantined", "reference-only"].includes(raw)) {
    throw new Error("--state must be accepted, catalog-only, quarantined, or reference-only");
  }
  return raw as ReleaseState;
}

function searchOptions(args: string[], maximum: number): SearchOptions {
  const agent = value(args, "--agent");
  const releaseState = state(args);
  return {
    ...(agent ? { agent } : {}),
    ...(releaseState ? { releaseState } : {}),
    limit: Math.min(limit(args), maximum)
  };
}

function hosts(raw: string | undefined): Host[] | "auto" {
  if (!raw || raw === "auto") return "auto";
  const parsed = [...new Set(raw.split(",").map((host) => host.trim()).filter(Boolean))];
  if (parsed.some((host) => !["codex", "claude", "opencode"].includes(host))) {
    throw new Error("--agents accepts auto or a comma-separated list of codex,claude,opencode");
  }
  return parsed as Host[];
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, subcommand] = args;
  if (!command || command === "help" || flag(args, "--help") || flag(args, "-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (command === "mcp") {
    await runStdioServer(value(args, "--host"));
    return;
  }
  if (command === "catalog" && subcommand === "status") {
    const catalog = await loadCatalog();
    print({
      version: "0.1.0",
      counts: catalog.counts,
      sourceSha256: catalog.sourceSha256,
      policy: "catalogue metadata is visible; only accepted providers are executable"
    });
    return;
  }
  if (command === "catalog" && subcommand === "list") {
    print(await listResources(searchOptions(args, 100)));
    return;
  }
  if (command === "catalog" && subcommand === "search") {
    const query = args.slice(2).filter((part: string, index: number, all: string[]) => {
      const prior = all[index - 1];
      return !part.startsWith("--") && !["--state", "--agent", "--limit"].includes(prior ?? "");
    }).join(" ");
    if (!query) throw new Error("catalog search requires a query");
    print(await searchResources(query, searchOptions(args, 50)));
    return;
  }
  if (command === "resolve") {
    const query = args.slice(1).join(" ").trim();
    if (!query) throw new Error("resolve requires a query");
    print(await resolveCapability(query));
    return;
  }
  if (command === "install") {
    const home = value(args, "--home");
    print(await installProduct({
      agents: hosts(value(args, "--agents")),
      ...(home ? { home } : {}),
      dryRun: flag(args, "--dry-run"),
      skipHostCommands: flag(args, "--skip-host-commands"),
      allowUnsignedDevelopment: flag(args, "--allow-unsigned-development")
    }));
    return;
  }
  if (command === "doctor") {
    print(await doctorProduct(value(args, "--home")));
    return;
  }
  if (command === "rollback" || command === "uninstall") {
    print(await rollbackLast(value(args, "--home")));
    return;
  }
  throw new Error(`Unknown command: ${args.join(" ")}\n\n${usage}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
