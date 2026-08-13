import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeOutput = resolve(root, "runtime", "server.mjs");
const cliOutput = resolve(root, "runtime", "cli.mjs");
const codexPlugin = resolve(root, "plugins", "unified-agent-dev");
const claudePlugin = resolve(root, "adapters", "claude-plugin");
const skillSource = resolve(codexPlugin, "skills", "unified-agent-dev");
const claudeSkill = resolve(claudePlugin, "skills", "unified-agent-dev");
const opencodeSkill = resolve(root, "adapters", "opencode", "skills", "unified-agent-dev");
const codexMarketplacePlugin = resolve(root, "marketplaces", "codex", "plugins", "unified-agent-dev");
const claudeMarketplacePlugin = resolve(root, "marketplaces", "claude", "plugins", "unified-agent-dev");

await mkdir(dirname(runtimeOutput), { recursive: true });
await build({
  entryPoints: [resolve(root, "src", "mcp-server.ts")],
  outfile: runtimeOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  mainFields: ["module", "main"],
  sourcemap: false,
  legalComments: "none"
});
await build({
  entryPoints: [resolve(root, "src", "cli.ts")],
  outfile: cliOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  mainFields: ["module", "main"],
  sourcemap: false,
  legalComments: "none"
});

for (const target of [
  resolve(codexPlugin, "runtime"),
  resolve(claudePlugin, "runtime"),
  claudeSkill,
  opencodeSkill,
  codexMarketplacePlugin,
  claudeMarketplacePlugin
]) {
  await rm(target, { recursive: true, force: true });
}
await mkdir(resolve(codexPlugin, "runtime"), { recursive: true });
await mkdir(resolve(claudePlugin, "runtime"), { recursive: true });
await cp(runtimeOutput, resolve(codexPlugin, "runtime", "server.mjs"));
await cp(runtimeOutput, resolve(claudePlugin, "runtime", "server.mjs"));
await cp(skillSource, claudeSkill, { recursive: true });
await cp(skillSource, opencodeSkill, { recursive: true });
await cp(codexPlugin, codexMarketplacePlugin, { recursive: true });
await cp(claudePlugin, claudeMarketplacePlugin, { recursive: true });

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Release build rejects links and special files: ${child}`);
  }
  return files;
}

const catalog = JSON.parse(await readFile(resolve(root, "catalog", "catalog.json"), "utf8"));
const runtimeRegistry = JSON.parse(await readFile(resolve(root, "catalog", "providers.runtime.json"), "utf8"));
const acceptedModules = catalog.resources
  .filter((resource) => resource.releaseState === "accepted")
  .map((resource) => resource.moduleId)
  .sort();
const runtimeModules = runtimeRegistry.providers.map((provider) => provider.moduleId).sort();
if (
  runtimeRegistry.generatedFrom !== catalog.sourceSha256 ||
  JSON.stringify(acceptedModules) !== JSON.stringify(runtimeModules)
) {
  throw new Error("Runtime registry is not the exact accepted projection of the public catalogue");
}
const providerArtifacts = catalog.resources
  .filter((resource) => resource.releaseState === "accepted")
  .map((resource) => resolve(root, ...resource.acceptance.artifact.relativePath.split("/")));
const roots = [
  resolve(root, "adapters"),
  resolve(root, "catalog", "catalog.json"),
  resolve(root, "catalog", "providers.runtime.json"),
  resolve(root, "marketplaces"),
  resolve(root, "plugins"),
  resolve(root, "runtime"),
  ...providerArtifacts
];
const releaseFiles = [];
for (const path of roots) {
  const candidates = (await readdir(path, { withFileTypes: true }).catch(() => null))
    ? await filesUnder(path)
    : [path];
  for (const file of candidates) {
    const bytes = await readFile(file);
    releaseFiles.push({
      path: relative(root, file).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength
    });
  }
}
releaseFiles.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  schemaVersion: 1,
  product: "unified-agent-dev",
  version: "0.1.0",
  channel: "development",
  generatedAt: "2026-08-13T00:00:00.000Z",
  catalogSha256: createHash("sha256")
    .update(await readFile(resolve(root, "catalog", "catalog.json")))
    .digest("hex"),
  acceptedProviders: catalog.counts.accepted,
  files: releaseFiles,
  signature: null
};
await mkdir(resolve(root, "release"), { recursive: true });
await writeFile(
  resolve(root, "release", "release.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
process.stdout.write(`Built release with ${releaseFiles.length} integrity-locked files\n`);
