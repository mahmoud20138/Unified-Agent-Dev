import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const catalogPath = resolve(root, "catalog", "catalog.json");
const sourcePath = resolve(root, "catalog", "source.yaml");
const outputPath = resolve(root, "docs", "CATALOG.md");
const checkOnly = process.argv.includes("--check");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const source = YAML.parse(await readFile(sourcePath, "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.resources) || catalog.resources.length !== 100) {
  throw new Error("catalog/catalog.json must contain exactly 100 schema-v1 resources");
}
if (source.schema_version !== 1 || !Array.isArray(source.resources) || source.resources.length !== 100) {
  throw new Error("catalog/source.yaml must contain exactly 100 schema-v1 resources");
}

const resources = [...catalog.resources].sort((a, b) => a.catalogId - b.catalogId);
const sourceById = new Map(source.resources.map((resource) => [resource.id, resource]));
for (let index = 0; index < resources.length; index += 1) {
  if (resources[index].catalogId !== index + 1) throw new Error("catalogue IDs must be ordered from 1 through 100");
  if (!sourceById.has(index + 1)) throw new Error(`catalog/source.yaml is missing entry ${index + 1}`);
}

function escapeCell(value) {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>");
}

function table(headers, rows) {
  const header = `| ${headers.map(escapeCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  return [header, divider, ...rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`)].join("\n");
}

function groups(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function family(resource) {
  return resource.category.split("/")[0].trim();
}

function repositoryRoot(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

function upstreamIdentity(resource) {
  const rootName = repositoryRoot(resource.canonicalUrl);
  return rootName ? `github:${rootName.toLowerCase()}` : resource.canonicalUrl.toLowerCase().replace(/\/$/, "");
}

function coreHostCombination(resource) {
  const coreHosts = ["Codex", "Claude Code", "OpenCode"];
  const present = coreHosts.filter((host) => resource.agents.includes(host));
  if (present.length === 0) return "None explicitly";
  return present.length === 1 ? `${present[0]} only` : present.join(" + ");
}

function entryTable(entries) {
  return table(
    ["ID", "Entry, module, and purpose", "Exact category", "Source", "Curated targets", "Proposed integration", "Research and release state"],
    entries.map((resource) => {
      const raw = sourceById.get(resource.catalogId);
      const originalLink = resource.originalUrl !== resource.canonicalUrl
        ? `<br>Original research URL: [link](${resource.originalUrl})`
        : "";
      return [
        resource.catalogId,
        `<a id="entry-${String(resource.catalogId).padStart(3, "0")}"></a>[${resource.name}](${resource.canonicalUrl})<br>\`${resource.moduleId}\`<br>${resource.description}`,
        resource.category,
        `${resource.sourceType}${originalLink}`,
        resource.agents.join("<br>"),
        `Mode: \`${resource.integrationMode}\`<br>Inferred role: \`${resource.intendedRole}\``,
        `Selection: \`${raw.selection_status}\`<br>License: \`${raw.license_status}\`<br>Release: \`${resource.releaseState}\`<br>${resource.acceptance.reason}`
      ];
    })
  );
}

const sourceTypes = groups(resources.map((resource) => resource.sourceType));
const categoryFamilies = groups(resources.map(family));
const roles = groups(resources.map((resource) => resource.intendedRole));
const releaseStates = groups(resources.map((resource) => resource.releaseState));
const agents = groups(resources.flatMap((resource) => resource.agents));
const integrationModes = groups(resources.map((resource) => resource.integrationMode));
const canonicalized = resources.filter((resource) => resource.canonicalization);
const selectionStatuses = groups(source.resources.map((resource) => resource.selection_status));
const licenseStatuses = groups(source.resources.map((resource) => resource.license_status));
const coreHostCombinations = groups(resources.map(coreHostCombination));
const uniqueUpstreamIdentities = new Set(resources.map(upstreamIdentity)).size;
const distinctCanonicalUrls = new Set(resources.map((resource) => resource.canonicalUrl)).size;

const roots = new Map();
for (const resource of resources) {
  const rootName = repositoryRoot(resource.canonicalUrl);
  if (!rootName) continue;
  const entries = roots.get(rootName) ?? [];
  entries.push(resource);
  roots.set(rootName, entries);
}
const sharedRepositoryRoots = [...roots.entries()]
  .filter(([, entries]) => entries.length > 1)
  .sort(([left], [right]) => left.localeCompare(right));

const sections = [
  "# Complete 100-entry catalogue",
  "",
  "> Generated from `catalog/catalog.json` by `scripts/build-catalog-doc.mjs`. Do not edit this file manually; run `npm run catalog:docs`.",
  "",
  `Catalogue source SHA-256: \`${catalog.sourceSha256}\``,
  "",
  "## How to read this catalogue",
  "",
  "- A catalogue entry is research metadata, not installed code.",
  "- `intendedRole` is mechanically inferred from the proposed `integrationMode`; neither field is an audit result or shipped functionality.",
  "- `releaseState` controls what this release may route. Only `accepted` entries may execute.",
  "- Curated target-host labels describe intended compatibility; they have not passed the Windows/provider acceptance gates.",
  "- `catalog-only` as a release state applies to all 100 entries. It is different from the seven entries whose inferred intended role is `catalog-only`.",
  "- Counts under target hosts overlap because one entry may support several agents.",
  "- One repository may produce several distinct resources. Identity is entry/resource based, not repository-root based.",
  "",
  "## Release snapshot",
  "",
  table(
    ["Measure", "Count"],
    [
      ["Catalogue entries/resources", resources.length],
      ["Unique upstream identities", uniqueUpstreamIdentities],
      ["Distinct canonical full URLs", distinctCanonicalUrls],
      ["Accepted executable providers", catalog.counts.accepted],
      ["Catalogue-only release entries", catalog.counts.catalogOnly],
      ["Quarantined entries", catalog.counts.quarantined],
      ["Reference-only entries", catalog.counts.referenceOnly],
      ["Canonical redirects/renames", canonicalized.length]
    ]
  ),
  "",
  "## Source-format mix",
  "",
  table(["Source type", "Entries", "Share"], sourceTypes.map(({ name, count }) => [name, count, `${count}%`])),
  "",
  "## Raw research-review mix",
  "",
  "These are input-review states, not runtime release states.",
  "",
  table(
    ["Input field", "Value", "Entries"],
    [
      ...selectionStatuses.map(({ name, count }) => ["Selection status", `\`${name}\``, count]),
      ...licenseStatuses.map(({ name, count }) => ["License status", `\`${name}\``, count])
    ]
  ),
  "",
  "## Category-family mix",
  "",
  table(["Category family", "Entries"], categoryFamilies.map(({ name, count }) => [name, count])),
  "",
  "## Intended-role mix",
  "",
  "These counts describe possible future integration roles. They are not counts of accepted providers.",
  "",
  table(["Intended role", "Entries"], roles.map(({ name, count }) => [`\`${name}\``, count])),
  "",
  "## Current release-state mix",
  "",
  table(["Release state", "Entries"], releaseStates.map(({ name, count }) => [`\`${name}\``, count])),
  "",
  "## Target-host mentions",
  "",
  "Counts overlap and therefore do not sum to 100.",
  "",
  table(["Target host or host family", "Entries mentioning target"], agents.map(({ name, count }) => [name, count])),
  "",
  "## Explicit Codex, Claude Code, and OpenCode combinations",
  "",
  "This table considers only exact mentions of the three core hosts. Generic labels such as `All coding agents` remain under `None explicitly`.",
  "",
  table(["Explicit core-host combination", "Entries"], coreHostCombinations.map(({ name, count }) => [name, count])),
  "",
  "## Intended integration-plan mix",
  "",
  "Integration plans are untrusted design hints until independently reviewed and admitted.",
  "",
  table(["Integration plan", "Entries"], integrationModes.map(({ name, count }) => [`\`${name}\``, count])),
  "",
  "## Shared repository roots",
  "",
  `The catalogue has 100 distinct entries/resources representing ${uniqueUpstreamIdentities} unique upstream identities, not 100 unique repository roots.`,
  "",
  sharedRepositoryRoots.length > 0
    ? table(
        ["Repository root", "Entry count", "Catalogue entries"],
        sharedRepositoryRoots.map(([rootName, entries]) => [
          `[${rootName}](https://github.com/${rootName})`,
          entries.length,
          entries.map((entry) => `#${entry.catalogId} ${entry.name}`).join("<br>")
        ])
      )
    : "No repository root is shared by multiple entries.",
  "",
  "## Canonical source corrections",
  "",
  canonicalized.length > 0
    ? table(
        ["ID", "Entry", "Original research URL", "Canonical URL", "Reason"],
        canonicalized.map((resource) => [
          resource.catalogId,
          resource.name,
          `[original](${resource.originalUrl})`,
          `[canonical](${resource.canonicalUrl})`,
          resource.canonicalization.reason
        ])
      )
    : "No canonical source corrections are recorded.",
  "",
  "## All 100 entries",
  "",
  ...categoryFamilies.flatMap(({ name, count }) => [
    `### ${name} (${count})`,
    "",
    entryTable(resources.filter((resource) => family(resource) === name)),
    ""
  ]),
  "## Machine-readable sources",
  "",
  "- `catalog/source.yaml` is the reviewed 100-entry research input.",
  "- `catalog/catalog.json` is the generated public metadata projection.",
  "- `catalog/providers.runtime.json` is the generated executable-provider projection and is empty in `0.1.0`.",
  "- `catalog/acceptance-overrides.json` contains admission evidence references and currently accepts no providers."
];

const rendered = `${sections.join("\n")}\n`;
if (checkOnly) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch {
    throw new Error("docs/CATALOG.md is missing; run npm run catalog:docs");
  }
  if (current !== rendered) throw new Error("docs/CATALOG.md is stale; run npm run catalog:docs");
  process.stdout.write("Verified docs/CATALOG.md against all 100 catalogue entries\n");
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered, "utf8");
  process.stdout.write("Generated docs/CATALOG.md for all 100 catalogue entries\n");
}
