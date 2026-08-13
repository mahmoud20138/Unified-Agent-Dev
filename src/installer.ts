import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError
} from "jsonc-parser";
import { sha256, verifyRelease } from "./integrity.js";

export const PRODUCT_VERSION = "0.1.0";
export type Host = "codex" | "claude" | "opencode";

interface FileOperation {
  type: "file";
  path: string;
  beforeBase64: string | null;
  afterSha256: string;
}

interface ReleaseOperation {
  type: "release";
  path: string;
  created: boolean;
}

interface HostOperation {
  type: "host";
  host: Host;
  action: string;
  compensation: string[];
  applied: boolean;
}

type Operation = FileOperation | ReleaseOperation | HostOperation;

interface Transaction {
  schemaVersion: 1;
  id: string;
  status:
    | "PREPARED"
    | "APPLYING"
    | "VERIFYING"
    | "COMMITTED"
    | "ROLLED_BACK"
    | "ROLLBACK_CONFLICT"
    | "FAILED";
  productVersion: string;
  createdAt: string;
  home: string;
  agents: Host[];
  operations: Operation[];
  error?: string;
}

export interface InstallOptions {
  home?: string;
  agents?: Host[] | "auto";
  dryRun?: boolean;
  skipHostCommands?: boolean;
  allowUnsignedDevelopment?: boolean;
}

export interface InstallResult {
  status: "dry-run" | "installed";
  version: string;
  home: string;
  releaseRoot: string;
  agents: Host[];
  transactionId?: string;
  warnings: string[];
  preflight?: Array<{ check: string; detail: string }>;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = moduleDirectory.endsWith(`${sep}runtime`)
  ? resolve(moduleDirectory, "..")
  : resolve(moduleDirectory, "..", "..");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ResolvedHostCommand {
  executable: string;
  prefixArgs: string[];
}

const resolvedCommands = new Map<string, ResolvedHostCommand | null>();

export function resolveHostCommand(command: string): ResolvedHostCommand | undefined {
  const cached = resolvedCommands.get(command);
  if (cached !== undefined) return cached ?? undefined;
  const check = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8",
    windowsHide: true
  });
  if (check.status !== 0) {
    resolvedCommands.set(command, null);
    return undefined;
  }
  const candidates = check.stdout.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  if (process.platform !== "win32") {
    const resolved = candidates[0] ? { executable: candidates[0], prefixArgs: [] } : null;
    resolvedCommands.set(command, resolved);
    return resolved ?? undefined;
  }
  for (const executable of candidates.filter((path) => path.toLowerCase().endsWith(".exe"))) {
    const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error) {
      const resolved = { executable, prefixArgs: [] };
      resolvedCommands.set(command, resolved);
      return resolved;
    }
  }
  for (const commandShim of candidates.filter((path) => path.toLowerCase().endsWith(".cmd"))) {
    const source = requireText(commandShim);
    const executableMatch = source.match(/"%dp0%\\([^"\r\n]+\.exe)"/i);
    if (executableMatch?.[1]) {
      const executable = resolve(dirname(commandShim), executableMatch[1]);
      const probe = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true });
      if (!probe.error) {
        const resolved = { executable, prefixArgs: [] };
        resolvedCommands.set(command, resolved);
        return resolved;
      }
    }
    const scriptMatch = source.match(/"%dp0%\\([^"\r\n]+\.js)"/i);
    if (scriptMatch?.[1]) {
      const script = resolve(dirname(commandShim), scriptMatch[1]);
      const resolved = { executable: process.execPath, prefixArgs: [script] };
      const probe = spawnSync(resolved.executable, [...resolved.prefixArgs, "--version"], {
        encoding: "utf8",
        windowsHide: true
      });
      if (!probe.error) {
        resolvedCommands.set(command, resolved);
        return resolved;
      }
    }
  }
  resolvedCommands.set(command, null);
  return undefined;
}

function requireText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function commandExists(command: string): boolean {
  return resolveHostCommand(command) !== undefined;
}

function detectHosts(): Host[] {
  return (["codex", "claude", "opencode"] as const).filter(commandExists);
}

function run(command: string, args: string[]): string {
  const resolved = resolveHostCommand(command);
  if (!resolved) throw new Error(`${command} has no safe native executable`);
  const result = spawnSync(resolved.executable, [...resolved.prefixArgs, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function parseJson(command: string, args: string[]): unknown {
  const output = run(command, args);
  return output ? JSON.parse(output) : null;
}

async function persistTransaction(path: string, transaction: Transaction): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(transaction, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireProductLock(productRoot: string): Promise<() => Promise<void>> {
  await mkdir(productRoot, { recursive: true });
  const path = resolve(productRoot, "install.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, pid: process.pid, token, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
      return async () => {
        await handle.close();
        try {
          const state = JSON.parse(await readFile(path, "utf8")) as { token?: string };
          if (state.token === token) await rm(path, { force: true });
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number } = {};
      try {
        owner = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
      } catch {
        throw new Error(`Install lock is unreadable: ${path}`);
      }
      if (Number.isInteger(owner.pid) && processIsAlive(owner.pid!)) {
        throw new Error(`Another Unified Agent Dev operation is active (PID ${owner.pid})`);
      }
      await rm(path, { force: true });
    }
  }
  throw new Error("Could not acquire the Unified Agent Dev install lock");
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function transactionalWrite(
  path: string,
  contents: Buffer | string,
  transaction: Transaction,
  transactionPath: string
): Promise<void> {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const before = await readOptional(path);
  transaction.operations.push({
    type: "file",
    path,
    beforeBase64: before?.toString("base64") ?? null,
    afterSha256: sha256(bytes)
  });
  await persistTransaction(transactionPath, transaction);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function copyDistribution(
  releaseRoot: string,
  transactionRoot: string,
  allowUnsignedDevelopment: boolean
): Promise<void> {
  if (await exists(releaseRoot)) {
    await verifyRelease(releaseRoot, { allowUnsignedDevelopment, strictFileSet: true });
    return;
  }
  const manifest = await verifyRelease(packageRoot, { allowUnsignedDevelopment });
  const staging = resolve(transactionRoot, "staged-release");
  await mkdir(staging, { recursive: true });
  for (const file of manifest.files) {
    const destination = resolve(staging, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(packageRoot, ...file.path.split("/")), destination);
  }
  const manifestDestination = resolve(staging, "release", "release.manifest.json");
  await mkdir(dirname(manifestDestination), { recursive: true });
  await cp(resolve(packageRoot, "release", "release.manifest.json"), manifestDestination);
  await verifyRelease(staging, { allowUnsignedDevelopment, strictFileSet: true });
  await mkdir(dirname(releaseRoot), { recursive: true });
  await rename(staging, releaseRoot);
}

function parseOpenCodeConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const detail = errors.map((error) => printParseErrorCode(error.error)).join(", ");
    throw new Error(`OpenCode configuration is invalid${detail ? `: ${detail}` : ""}`);
  }
  return parsed as Record<string, unknown>;
}

function mergeOpenCodeConfig(existingText: string, serverPath: string): string {
  const config = parseOpenCodeConfig(existingText);
  const mcp = config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)
    ? { ...(config.mcp as Record<string, unknown>) }
    : {};
  const current = mcp["unified-agent-dev"];
  if (current && JSON.stringify(current).includes(".unified-agent-dev") === false) {
    throw new Error("OpenCode already has an unmanaged MCP entry named unified-agent-dev");
  }
  const managedEntry = {
    type: "local",
    command: [process.execPath, serverPath, "--host", "opencode"],
    enabled: true,
    timeout: 10000
  };
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  let output = existingText;
  if (!("$schema" in config)) {
    output = applyEdits(output, modify(output, ["$schema"], "https://opencode.ai/config.json", { formattingOptions }));
  }
  output = applyEdits(
    output,
    modify(output, ["mcp", "unified-agent-dev"], managedEntry, { formattingOptions })
  );
  return output.endsWith("\n") ? output : `${output}\n`;
}

async function openCodePaths(home: string): Promise<{ configRoot: string; configPath: string }> {
  const configuredFile = process.env.OPENCODE_CONFIG;
  const configRoot = resolve(process.env.OPENCODE_CONFIG_DIR ?? resolve(home, ".config", "opencode"));
  if (configuredFile) return { configRoot: dirname(resolve(configuredFile)), configPath: resolve(configuredFile) };
  const jsonPath = resolve(configRoot, "opencode.json");
  const jsoncPath = resolve(configRoot, "opencode.jsonc");
  const [hasJson, hasJsonc] = await Promise.all([exists(jsonPath), exists(jsoncPath)]);
  if (hasJson && hasJsonc) {
    throw new Error("Both opencode.json and opencode.jsonc exist; set OPENCODE_CONFIG to select the active file");
  }
  return { configRoot, configPath: hasJsonc ? jsoncPath : jsonPath };
}

async function preflightOpenCode(home: string, releaseRoot: string): Promise<void> {
  const { configRoot, configPath } = await openCodePaths(home);
  const existingBytes = await readOptional(configPath);
  mergeOpenCodeConfig(existingBytes?.toString("utf8") ?? "{}\n", resolve(releaseRoot, "runtime", "server.mjs"));
  const skillTarget = resolve(configRoot, "skills", "unified-agent-dev", "SKILL.md");
  const existingSkill = await readOptional(skillTarget);
  if (existingSkill && !existingSkill.includes(Buffer.from("managed-by: unified-agent-dev"))) {
    throw new Error("OpenCode already has an unmanaged unified-agent-dev skill");
  }
}

async function configureOpenCode(
  home: string,
  releaseRoot: string,
  transaction: Transaction,
  transactionPath: string
): Promise<void> {
  const { configRoot, configPath } = await openCodePaths(home);
  await preflightOpenCode(home, releaseRoot);
  const existingBytes = await readOptional(configPath);
  const serverPath = resolve(releaseRoot, "runtime", "server.mjs");
  await transactionalWrite(
    configPath,
    mergeOpenCodeConfig(existingBytes?.toString("utf8") ?? "{}\n", serverPath),
    transaction,
    transactionPath
  );
  const skillSource = resolve(releaseRoot, "adapters", "opencode", "skills", "unified-agent-dev", "SKILL.md");
  const skillTarget = resolve(configRoot, "skills", "unified-agent-dev", "SKILL.md");
  await transactionalWrite(skillTarget, await readFile(skillSource), transaction, transactionPath);
}

function normalizePath(path: string): string {
  return resolve(path.replace(/^\\\\\?\\/, "")).toLowerCase();
}

function ownedCurrentInstall(home: string, releaseRoot: string, host: Host): boolean {
  try {
    const current = JSON.parse(requireText(resolve(home, ".unified-agent-dev", "current.json"))) as {
      releaseRoot?: string;
      agents?: Host[];
    };
    return normalizePath(current.releaseRoot ?? "") === normalizePath(releaseRoot) && current.agents?.includes(host) === true;
  } catch {
    return false;
  }
}

function codexState(releaseRoot?: string): { marketplace: boolean; plugin: boolean } {
  const marketplaces = parseJson("codex", ["plugin", "marketplace", "list", "--json"]) as {
    marketplaces?: Array<{ name?: string; root?: string }>;
  };
  const plugins = parseJson("codex", ["plugin", "list", "--json"]) as {
    installed?: Array<{ pluginId?: string; version?: string; enabled?: boolean }>;
  };
  const marketplace = marketplaces.marketplaces?.find((item) => item.name === "unified-agent-dev-local");
  if (
    marketplace && releaseRoot &&
    normalizePath(marketplace.root ?? "") !== normalizePath(resolve(releaseRoot, "marketplaces", "codex"))
  ) {
    throw new Error(`Codex marketplace name collision at ${marketplace.root ?? "unknown source"}`);
  }
  const plugin = plugins.installed?.find((item) => item.pluginId === "unified-agent-dev@unified-agent-dev-local");
  if (plugin && (plugin.version !== PRODUCT_VERSION || plugin.enabled !== true)) {
    throw new Error(`Codex plugin collision or stale state: version=${plugin.version}, enabled=${plugin.enabled}`);
  }
  return {
    marketplace: Boolean(marketplace),
    plugin: Boolean(plugin)
  };
}

function claudeState(
  home: string,
  releaseRoot?: string,
  allowUncommitted = false
): { marketplace: boolean; plugin: boolean } {
  const marketplaces = parseJson("claude", ["plugin", "marketplace", "list", "--json"]) as Array<{
    name?: string;
    installLocation?: string;
  }>;
  const plugins = parseJson("claude", ["plugin", "list", "--json"]) as Array<{
    id?: string;
    version?: string;
    enabled?: boolean;
  }>;
  const marketplace = marketplaces.find((item) => item.name === "unified-agent-dev-local");
  if (marketplace && releaseRoot && !allowUncommitted && !ownedCurrentInstall(home, releaseRoot, "claude")) {
    throw new Error(`Claude marketplace name collision at ${marketplace.installLocation ?? "unknown source"}`);
  }
  const plugin = plugins.find((item) => item.id === "unified-agent-dev@unified-agent-dev-local");
  if (plugin && (plugin.version !== PRODUCT_VERSION || plugin.enabled !== true)) {
    throw new Error(`Claude plugin collision or stale state: version=${plugin.version}, enabled=${plugin.enabled}`);
  }
  return {
    marketplace: Boolean(marketplace),
    plugin: Boolean(plugin)
  };
}

async function registerHost(
  host: Host,
  releaseRoot: string,
  transaction: Transaction,
  transactionPath: string
): Promise<void> {
  if (host === "opencode") return;
  if (host === "codex") {
    const state = codexState(releaseRoot);
    if (!state.marketplace) {
      const operation: HostOperation = {
        type: "host",
        host,
        action: "marketplace-add",
        compensation: ["plugin", "marketplace", "remove", "unified-agent-dev-local"],
        applied: false
      };
      transaction.operations.push(operation);
      await persistTransaction(transactionPath, transaction);
      run("codex", ["plugin", "marketplace", "add", resolve(releaseRoot, "marketplaces", "codex"), "--json"]);
      operation.applied = true;
      await persistTransaction(transactionPath, transaction);
    }
    if (!state.plugin) {
      const operation: HostOperation = {
        type: "host",
        host,
        action: "plugin-add",
        compensation: ["plugin", "remove", "unified-agent-dev@unified-agent-dev-local", "--json"],
        applied: false
      };
      transaction.operations.push(operation);
      await persistTransaction(transactionPath, transaction);
      run("codex", ["plugin", "add", "unified-agent-dev@unified-agent-dev-local", "--json"]);
      operation.applied = true;
      await persistTransaction(transactionPath, transaction);
    }
    return;
  }
  const state = claudeState(transaction.home, releaseRoot);
  if (!state.marketplace) {
    const operation: HostOperation = {
      type: "host",
      host,
      action: "marketplace-add",
      compensation: ["plugin", "marketplace", "remove", "unified-agent-dev-local"],
      applied: false
    };
    transaction.operations.push(operation);
    await persistTransaction(transactionPath, transaction);
    run("claude", ["plugin", "marketplace", "add", resolve(releaseRoot, "marketplaces", "claude"), "--scope", "user"]);
    operation.applied = true;
    await persistTransaction(transactionPath, transaction);
  }
  if (!state.plugin) {
    const operation: HostOperation = {
      type: "host",
      host,
      action: "plugin-add",
      compensation: ["plugin", "uninstall", "unified-agent-dev@unified-agent-dev-local", "--scope", "user", "--yes"],
      applied: false
    };
    transaction.operations.push(operation);
    await persistTransaction(transactionPath, transaction);
    run("claude", ["plugin", "install", "unified-agent-dev@unified-agent-dev-local", "--scope", "user"]);
    operation.applied = true;
    await persistTransaction(transactionPath, transaction);
  }
}

async function verifyOpenCodeInstallation(home: string, releaseRoot: string): Promise<void> {
  const { configRoot, configPath } = await openCodePaths(home);
  const config = parseOpenCodeConfig(await readFile(configPath, "utf8")) as {
    mcp?: Record<string, { type?: string; command?: string[]; enabled?: boolean }>;
  };
  const entry = config.mcp?.["unified-agent-dev"];
  const expectedServer = resolve(releaseRoot, "runtime", "server.mjs");
  if (
    entry?.type !== "local" ||
    entry.enabled !== true ||
    entry.command?.[0] !== process.execPath ||
    normalizePath(entry.command?.[1] ?? "") !== normalizePath(expectedServer) ||
    entry.command?.[2] !== "--host" ||
    entry.command?.[3] !== "opencode"
  ) {
    throw new Error("OpenCode MCP configuration does not match the managed release");
  }
  const skill = await readFile(resolve(configRoot, "skills", "unified-agent-dev", "SKILL.md"));
  if (!skill.includes(Buffer.from("managed-by: unified-agent-dev"))) {
    throw new Error("OpenCode managed skill is missing or has been replaced");
  }
}

async function preflightInstallation(
  home: string,
  releaseRoot: string,
  agents: Host[],
  skipHostCommands: boolean,
  allowUnsignedDevelopment: boolean
): Promise<Array<{ check: string; detail: string }>> {
  const details: Array<{ check: string; detail: string }> = [];
  const manifest = await verifyRelease(packageRoot, { allowUnsignedDevelopment });
  details.push({ check: "source-release", detail: `${manifest.channel} ${manifest.version}; ${manifest.files.length} files` });
  if (await exists(releaseRoot)) {
    await verifyRelease(releaseRoot, { allowUnsignedDevelopment, strictFileSet: true });
    details.push({ check: "existing-release", detail: "integrity verified" });
  }
  if (agents.includes("opencode")) {
    await preflightOpenCode(home, releaseRoot);
    details.push({ check: "opencode-files", detail: "configuration and skill paths are writable without ownership conflicts" });
  }
  if (!skipHostCommands) {
    for (const host of agents) {
      const command = resolveHostCommand(host);
      if (!command) throw new Error(`${host} is selected but no safe native executable is available`);
      const version = run(host, ["--version"]);
      details.push({ check: `${host}-cli`, detail: `${version}; executable=${command.executable}` });
    }
    if (agents.includes("codex")) codexState(releaseRoot);
    if (agents.includes("claude")) {
      run("claude", ["plugin", "validate", resolve(packageRoot, "marketplaces", "claude"), "--strict"]);
      claudeState(home, releaseRoot);
    }
  }
  return details;
}

async function postflightInstallation(
  home: string,
  releaseRoot: string,
  agents: Host[],
  skipHostCommands: boolean
): Promise<void> {
  const smoke = spawnSync(process.execPath, [resolve(releaseRoot, "runtime", "cli.mjs"), "catalog", "status"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (smoke.status !== 0 || JSON.parse(smoke.stdout).counts?.catalogue !== 100) {
    throw new Error(`Installed core smoke test failed: ${smoke.error?.message ?? smoke.stderr}`);
  }
  if (agents.includes("opencode")) await verifyOpenCodeInstallation(home, releaseRoot);
  if (skipHostCommands) return;
  if (agents.includes("codex")) {
    const state = codexState(releaseRoot);
    if (!state.marketplace || !state.plugin) throw new Error("Codex postflight did not find the installed plugin");
  }
  if (agents.includes("claude")) {
    run("claude", ["plugin", "validate", resolve(releaseRoot, "marketplaces", "claude"), "--strict"]);
    const state = claudeState(home, releaseRoot, true);
    if (!state.marketplace || !state.plugin) throw new Error("Claude postflight did not find the installed plugin");
  }
  if (agents.includes("opencode") && home === resolve(homedir())) {
    run("opencode", ["debug", "config"]);
    const skills = run("opencode", ["debug", "skill"]);
    if (!skills.includes("unified-agent-dev")) throw new Error("OpenCode did not discover the unified skill");
    run("opencode", ["mcp", "list"]);
  }
}

async function reverseOperations(transaction: Transaction): Promise<string[]> {
  const conflicts: string[] = [];
  const appliedFiles = new Set<FileOperation>();
  const appliedHosts = new Set<HostOperation>();
  const appliedReleases = new Set<ReleaseOperation>();
  for (const operation of transaction.operations) {
    if (operation.type !== "file") continue;
    const current = await readOptional(operation.path);
    const currentHash = current ? sha256(current) : null;
    const beforeHash = operation.beforeBase64 === null
      ? null
      : sha256(Buffer.from(operation.beforeBase64, "base64"));
    if (currentHash === operation.afterSha256) {
      appliedFiles.add(operation);
    } else if (currentHash !== beforeHash) {
      conflicts.push(operation.path);
    }
  }
  const expectedReleaseRoot = resolve(
    transaction.home,
    ".unified-agent-dev",
    "releases",
    transaction.productVersion
  );
  for (const operation of transaction.operations) {
    if (operation.type === "host") {
      if (!commandExists(operation.host)) {
        if (operation.applied) conflicts.push(`${operation.host}:${operation.action}:CLI unavailable`);
        continue;
      }
      try {
        const state = operation.host === "codex"
          ? codexState(expectedReleaseRoot)
          : claudeState(transaction.home, expectedReleaseRoot, true);
        const present = operation.action === "plugin-add" ? state.plugin : state.marketplace;
        if (present) appliedHosts.add(operation);
      } catch (error: unknown) {
        conflicts.push(`${operation.host}:${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (operation.type === "release" && operation.created && await exists(operation.path)) {
      try {
        await verifyRelease(operation.path, { allowUnsignedDevelopment: true, strictFileSet: true });
        appliedReleases.add(operation);
      } catch (error: unknown) {
        conflicts.push(`${operation.path}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (conflicts.length > 0) return conflicts;
  for (const operation of [...transaction.operations].reverse()) {
    try {
      if (operation.type === "host") {
        if (appliedHosts.has(operation)) run(operation.host, operation.compensation);
        continue;
      }
      if (operation.type === "file") {
        if (!appliedFiles.has(operation)) continue;
        if (operation.beforeBase64 === null) {
          await rm(operation.path, { force: true });
        } else {
          await mkdir(dirname(operation.path), { recursive: true });
          await writeFile(operation.path, Buffer.from(operation.beforeBase64, "base64"));
        }
        continue;
      }
      if (appliedReleases.has(operation)) {
        await rm(operation.path, { recursive: true, force: true });
      }
    } catch (error: unknown) {
      conflicts.push(`${operation.type}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return conflicts;
}

async function recoverIncompleteTransactions(productRoot: string): Promise<void> {
  const transactionsRoot = resolve(productRoot, "transactions");
  let entries;
  try {
    entries = await readdir(transactionsRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(transactionsRoot, entry.name, "transaction.json");
    const transaction = JSON.parse(await readFile(path, "utf8")) as Transaction;
    if (!["PREPARED", "APPLYING", "VERIFYING"].includes(transaction.status)) continue;
    const conflicts = await reverseOperations(transaction);
    transaction.status = conflicts.length === 0 ? "ROLLED_BACK" : "ROLLBACK_CONFLICT";
    transaction.error = conflicts.length === 0
      ? "Recovered automatically after an interrupted installation."
      : `Interrupted install rollback conflicts: ${conflicts.join(", ")}`;
    await persistTransaction(path, transaction);
    if (conflicts.length > 0) {
      throw new Error(`Interrupted transaction ${transaction.id} requires manual conflict resolution: ${conflicts.join(", ")}`);
    }
  }
}

export async function installProduct(options: InstallOptions = {}): Promise<InstallResult> {
  if (process.platform !== "win32") throw new Error("Version 0.1.0 supports Windows only");
  const home = resolve(options.home ?? homedir());
  const agents = options.agents === "auto" || options.agents === undefined
    ? detectHosts()
    : [...new Set(options.agents)];
  if (agents.some((agent) => !(["codex", "claude", "opencode"] as string[]).includes(agent))) {
    throw new Error("Agents must be codex, claude, or opencode");
  }
  if (!options.skipHostCommands && home !== resolve(homedir()) && agents.some((host) => host !== "opencode")) {
    throw new Error("Codex/Claude host commands can target only the current user's home directory");
  }
  const productRoot = resolve(home, ".unified-agent-dev");
  const releaseRoot = resolve(productRoot, "releases", PRODUCT_VERSION);
  const allowUnsignedDevelopment = options.allowUnsignedDevelopment === true;
  const manifest = await verifyRelease(packageRoot, { allowUnsignedDevelopment });
  const preflight = await preflightInstallation(
    home,
    releaseRoot,
    agents,
    options.skipHostCommands === true,
    allowUnsignedDevelopment
  );
  const warnings: string[] = [];
  if (agents.length === 0) warnings.push("No supported agent CLI was detected; the core release would be installed only.");
  if (options.allowUnsignedDevelopment) warnings.push("Installed an unsigned development build; do not redistribute it as a public release.");
  if (options.dryRun) {
    return { status: "dry-run", version: PRODUCT_VERSION, home, releaseRoot, agents, warnings, preflight };
  }

  const releaseLock = await acquireProductLock(productRoot);
  try {
    await recoverIncompleteTransactions(productRoot);
    await preflightInstallation(
      home,
      releaseRoot,
      agents,
      options.skipHostCommands === true,
      allowUnsignedDevelopment
    );
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const transactionRoot = resolve(productRoot, "transactions", id);
  const transactionPath = resolve(transactionRoot, "transaction.json");
  const transaction: Transaction = {
    schemaVersion: 1,
    id,
    status: "PREPARED",
    productVersion: PRODUCT_VERSION,
    createdAt: new Date().toISOString(),
    home,
    agents,
    operations: []
  };
  await persistTransaction(transactionPath, transaction);
  try {
    transaction.status = "APPLYING";
    await persistTransaction(transactionPath, transaction);
    const created = !(await exists(releaseRoot));
    transaction.operations.push({ type: "release", path: releaseRoot, created });
    await persistTransaction(transactionPath, transaction);
    await copyDistribution(releaseRoot, transactionRoot, allowUnsignedDevelopment);

    if (agents.includes("opencode")) {
      await configureOpenCode(home, releaseRoot, transaction, transactionPath);
    }
    if (!options.skipHostCommands) {
      for (const host of agents) await registerHost(host, releaseRoot, transaction, transactionPath);
    } else if (agents.some((host) => host !== "opencode")) {
      warnings.push("Codex/Claude host registration was skipped by request.");
    }

    transaction.status = "VERIFYING";
    await persistTransaction(transactionPath, transaction);
    await verifyRelease(releaseRoot, {
      allowUnsignedDevelopment,
      strictFileSet: true
    });
    await postflightInstallation(home, releaseRoot, agents, options.skipHostCommands === true);
    const currentPath = resolve(productRoot, "current.json");
    await transactionalWrite(
      currentPath,
      `${JSON.stringify({
        schemaVersion: 1,
        version: PRODUCT_VERSION,
        transactionId: id,
        releaseRoot,
        agents,
        releaseChannel: manifest.channel,
        allowUnsignedDevelopment,
        installedAt: new Date().toISOString()
      }, null, 2)}\n`,
      transaction,
      transactionPath
    );
    transaction.status = "COMMITTED";
    await persistTransaction(transactionPath, transaction);
    return {
      status: "installed",
      version: PRODUCT_VERSION,
      home,
      releaseRoot,
      agents,
      transactionId: id,
      warnings,
      preflight
    };
  } catch (error: unknown) {
    transaction.error = error instanceof Error ? error.message : String(error);
    const conflicts = await reverseOperations(transaction);
    transaction.status = conflicts.length === 0 ? "ROLLED_BACK" : "ROLLBACK_CONFLICT";
    if (conflicts.length > 0) transaction.error += `; rollback conflicts: ${conflicts.join(", ")}`;
    await persistTransaction(transactionPath, transaction);
    throw error;
  }
  } finally {
    await releaseLock();
  }
}

export async function rollbackLast(homeOption?: string): Promise<{ transactionId: string; conflicts: string[] }> {
  const home = resolve(homeOption ?? homedir());
  const productRoot = resolve(home, ".unified-agent-dev");
  const releaseLock = await acquireProductLock(productRoot);
  try {
  const current = JSON.parse(await readFile(resolve(productRoot, "current.json"), "utf8")) as {
    transactionId: string;
  };
  const transactionPath = resolve(productRoot, "transactions", current.transactionId, "transaction.json");
  const transaction = JSON.parse(await readFile(transactionPath, "utf8")) as Transaction;
  if (!["COMMITTED", "ROLLBACK_CONFLICT"].includes(transaction.status)) {
    throw new Error(`Transaction ${transaction.id} cannot be rolled back from ${transaction.status}`);
  }
  const conflicts = await reverseOperations(transaction);
  transaction.status = conflicts.length === 0 ? "ROLLED_BACK" : "ROLLBACK_CONFLICT";
  if (conflicts.length > 0) transaction.error = `Rollback conflicts: ${conflicts.join(", ")}`;
  await persistTransaction(transactionPath, transaction);
  return { transactionId: transaction.id, conflicts };
  } finally {
    await releaseLock();
  }
}

export async function doctorProduct(homeOption?: string): Promise<Record<string, unknown>> {
  const home = resolve(homeOption ?? homedir());
  const productRoot = resolve(home, ".unified-agent-dev");
  const currentPath = resolve(productRoot, "current.json");
  if (!(await exists(currentPath))) {
    return { healthy: false, home, error: "Unified Agent Dev is not installed." };
  }
  const current = JSON.parse(await readFile(currentPath, "utf8")) as {
    version: string;
    releaseRoot: string;
    agents: Host[];
    transactionId: string;
    releaseChannel: "development" | "public";
    allowUnsignedDevelopment: boolean;
  };
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  try {
    const manifest = await verifyRelease(current.releaseRoot, {
      allowUnsignedDevelopment:
        current.releaseChannel === "development" && current.allowUnsignedDevelopment === true,
      strictFileSet: true
    });
    if (manifest.channel !== current.releaseChannel) {
      throw new Error(`Release trust channel changed from ${current.releaseChannel} to ${manifest.channel}`);
    }
    checks.push({ name: "release-integrity", ok: true, detail: `${manifest.files.length} files verified` });
    checks.push({
      name: "release-trust",
      ok: manifest.signature !== null || (manifest.channel === "development" && current.allowUnsignedDevelopment === true),
      detail: manifest.signature
        ? `trusted signature ${manifest.signature.keyId}`
        : "explicitly authorized unsigned development build"
    });
  } catch (error: unknown) {
    checks.push({ name: "release-integrity", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  if (current.agents.includes("opencode")) {
    try {
      await verifyOpenCodeInstallation(home, current.releaseRoot);
      checks.push({ name: "opencode-adapter", ok: true, detail: "managed MCP entry and skill verified" });
    } catch (error: unknown) {
      checks.push({ name: "opencode-adapter", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  if (current.agents.includes("codex")) {
    if (!commandExists("codex")) {
      checks.push({ name: "codex-adapter", ok: false, detail: "codex CLI is not available" });
    } else {
      try {
        const state = codexState(current.releaseRoot);
        checks.push({
          name: "codex-adapter",
          ok: state.marketplace && state.plugin,
          detail: `marketplace=${state.marketplace}, plugin=${state.plugin}`
        });
      } catch (error: unknown) {
        checks.push({ name: "codex-adapter", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (current.agents.includes("claude")) {
    if (!commandExists("claude")) {
      checks.push({ name: "claude-adapter", ok: false, detail: "claude CLI is not available" });
    } else {
      try {
        const state = claudeState(home, current.releaseRoot);
        checks.push({
          name: "claude-adapter",
          ok: state.marketplace && state.plugin,
          detail: `marketplace=${state.marketplace}, plugin=${state.plugin}`
        });
      } catch (error: unknown) {
        checks.push({ name: "claude-adapter", ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return {
    healthy: checks.every((check) => check.ok),
    home,
    current,
    checks
  };
}
