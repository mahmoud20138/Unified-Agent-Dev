import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(projectRoot, "catalog", "source.yaml");
const overridesPath = resolve(projectRoot, "catalog", "acceptance-overrides.json");
const canonicalOverridesPath = resolve(projectRoot, "catalog", "canonical-overrides.json");
const outputPath = resolve(projectRoot, "catalog", "catalog.json");
const runtimeOutputPath = resolve(projectRoot, "catalog", "providers.runtime.json");
const generatedOutputPath = resolve(projectRoot, "src", "generated", "catalog.ts");
const generatedRuntimeOutputPath = resolve(projectRoot, "src", "generated", "runtime.ts");

const rawSource = await readFile(sourcePath, "utf8");
const source = YAML.parse(rawSource);
const overrides = JSON.parse(await readFile(overridesPath, "utf8"));
const canonicalOverrides = JSON.parse(await readFile(canonicalOverridesPath, "utf8"));

if (source?.schema_version !== 1 || !Array.isArray(source?.resources)) {
  throw new Error("catalog/source.yaml must contain schema_version: 1 and a resources array");
}
if (source.resources.length !== 100) {
  throw new Error(`Expected exactly 100 research catalogue entries; found ${source.resources.length}`);
}
if (
  overrides?.schemaVersion !== 1 ||
  typeof overrides?.releaseAsOf !== "string" ||
  !Number.isFinite(Date.parse(overrides.releaseAsOf)) ||
  !Array.isArray(overrides?.providers)
) {
  throw new Error("catalog/acceptance-overrides.json must contain schemaVersion: 1, releaseAsOf, and providers[]");
}
if (canonicalOverrides?.schemaVersion !== 1 || !Array.isArray(canonicalOverrides?.entries)) {
  throw new Error("catalog/canonical-overrides.json must contain schemaVersion: 1 and entries[]");
}

const unique = (field) => {
  const values = source.resources.map((resource) => resource[field]);
  if (new Set(values).size !== values.length) {
    throw new Error(`Catalogue field ${field} must be unique`);
  }
};
unique("id");
unique("name");
for (const resource of source.resources) {
  if (
    !Number.isInteger(resource.id) ||
    typeof resource.name !== "string" || resource.name.trim().length === 0 ||
    !["GitHub repository", "GitHub plugin directory", "npm package"].includes(resource.source_type) ||
    typeof resource.url !== "string" || !resource.url.startsWith("https://") ||
    typeof resource.category !== "string" || resource.category.trim().length === 0 ||
    !Array.isArray(resource.agents) || resource.agents.length === 0 ||
    resource.agents.some((agent) => typeof agent !== "string" || agent.trim().length === 0) ||
    typeof resource.description !== "string" || resource.description.trim().length === 0 ||
    typeof resource.integration_mode !== "string" || resource.integration_mode.trim().length === 0 ||
    resource.selection_status !== "selected-candidate" ||
    resource.license_status !== "verify-before-bundling"
  ) {
    throw new Error(`Catalogue entry ${resource.id} does not satisfy the candidate schema`);
  }
  const parsedUrl = new URL(resource.url);
  if (parsedUrl.protocol !== "https:") throw new Error(`Catalogue entry ${resource.id} must use HTTPS`);
}
const expectedIds = Array.from({ length: 100 }, (_, index) => index + 1);
if (source.resources.some((resource, index) => resource.id !== expectedIds[index])) {
  throw new Error("Catalogue IDs must be the ordered integers 1 through 100");
}

const byId = new Map(source.resources.map((resource) => [resource.id, resource]));
const canonicalById = new Map();
for (const override of canonicalOverrides.entries) {
  if (!Number.isInteger(override?.catalogId) || !byId.has(override.catalogId)) {
    throw new Error(`Canonical override has an unknown catalogId: ${override?.catalogId}`);
  }
  if (canonicalById.has(override.catalogId)) {
    throw new Error(`Duplicate canonical override for catalogId ${override.catalogId}`);
  }
  if (typeof override.canonicalUrl !== "string" || !override.canonicalUrl.startsWith("https://")) {
    throw new Error(`Canonical override ${override.catalogId} must use an HTTPS URL`);
  }
  canonicalById.set(override.catalogId, override);
}
const overrideById = new Map();
const sha256Pattern = /^[a-f0-9]{64}$/;
const providersRoot = resolve(projectRoot, "providers");
const evidenceRoot = resolve(projectRoot, "audit", "evidence");

const verifyBoundEvidence = async (relativePath, expectedDigest, root, label, expected) => {
  if (
    typeof relativePath !== "string" ||
    relativePath.includes("..") ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/")
  ) {
    throw new Error(`${label} requires a safe relative evidence path`);
  }
  const absolutePath = resolve(projectRoot, ...relativePath.split("/"));
  if (!absolutePath.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes its allowed root`);
  const bytes = await readFile(absolutePath);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
    throw new Error(`${label} hash does not match its evidence file`);
  }
  let evidence;
  try {
    evidence = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be a JSON evidence document`);
  }
  if (evidence.schemaVersion !== 1) throw new Error(`${label} has an unsupported evidence schema`);
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (JSON.stringify(evidence[field]) !== JSON.stringify(expectedValue)) {
      throw new Error(`${label} field ${field} is not bound to the accepted artifact`);
    }
  }
};

for (const override of overrides.providers) {
  if (!Number.isInteger(override?.catalogId) || !byId.has(override.catalogId)) {
    throw new Error(`Acceptance override has an unknown catalogId: ${override?.catalogId}`);
  }
  if (overrideById.has(override.catalogId)) {
    throw new Error(`Duplicate acceptance override for catalogId ${override.catalogId}`);
  }
  if (!["accepted", "catalog-only", "quarantined", "reference-only"].includes(override.releaseState)) {
    throw new Error(`Invalid releaseState for catalogId ${override.catalogId}`);
  }
  if (override.releaseState === "accepted") {
    const required = [
      override?.lock?.resolvedIdentity,
      override?.lock?.treeSha256,
      override?.license?.spdx,
      override?.license?.evidenceSha256,
      override?.audit?.reportSha256,
      override?.audit?.reviewedAt,
      override?.audit?.reviewer
    ];
    if (required.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error(
        `Accepted catalogId ${override.catalogId} requires immutable lock, license evidence, and reviewed audit evidence`
      );
    }
    for (const [label, digest] of [
      ["lock.evidenceSha256", override.lock.evidenceSha256],
      ["lock.treeSha256", override.lock.treeSha256],
      ["license.evidenceSha256", override.license.evidenceSha256],
      ["audit.reportSha256", override.audit.reportSha256],
      ["windows.evidenceSha256", override?.windows?.evidenceSha256],
      ["artifact.sha256", override?.artifact?.sha256]
    ]) {
      if (typeof digest !== "string" || !sha256Pattern.test(digest)) {
        throw new Error(`Accepted catalogId ${override.catalogId} requires a lowercase SHA-256 ${label}`);
      }
    }
    const sourceResource = byId.get(override.catalogId);
    const canonicalSource = canonicalById.get(override.catalogId)?.canonicalUrl ?? sourceResource.url;
    if (
      override.lock.sourceType !== sourceResource.source_type ||
      override.lock.canonicalUrl !== canonicalSource
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} lock is not bound to its canonical source identity`);
    }
    if (!["git", "npm", "descriptor"].includes(override?.lock?.kind)) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a supported immutable lock kind`);
    }
    const expectedLockKind = sourceResource.source_type === "npm package" ? "npm" : "git";
    if (override.lock.kind !== expectedLockKind) {
      throw new Error(`Accepted catalogId ${override.catalogId} lock kind does not match its source type`);
    }
    if (
      override.lock.kind === "git" &&
      (!/^[a-f0-9]{40}$/.test(override.lock.resolvedIdentity) ||
        typeof override.lock.repositoryNodeId !== "string" ||
        override.lock.repositoryNodeId.length === 0 ||
        !Array.isArray(override.lock.submodules) ||
        !["absent", "fully-pinned"].includes(override.lock.submoduleDisposition) ||
        !["absent", "fully-pinned"].includes(override.lock.lfsDisposition))
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a fully specified Git lock`);
    }
    if (override.lock.kind === "git") {
      if (
        override.lock.submoduleDisposition === "absent" && override.lock.submodules.length !== 0
      ) {
        throw new Error(`Accepted catalogId ${override.catalogId} declares absent submodules but lists pins`);
      }
      if (
        override.lock.submoduleDisposition === "fully-pinned" &&
        (override.lock.submodules.length === 0 || override.lock.submodules.some((submodule) =>
          typeof submodule?.path !== "string" ||
          submodule.path.includes("..") ||
          !/^[a-f0-9]{40}$/.test(submodule?.commit) ||
          !sha256Pattern.test(submodule?.treeSha256)
        ))
      ) {
        throw new Error(`Accepted catalogId ${override.catalogId} has an incomplete submodule lock`);
      }
      if (sourceResource.source_type === "GitHub plugin directory") {
        if (
          typeof override.lock.subdir !== "string" ||
          override.lock.subdir.length === 0 ||
          override.lock.subdir.includes("..") ||
          override.lock.subdir.includes("\\") ||
          !sha256Pattern.test(override.lock.subdirTreeSha256)
        ) {
          throw new Error(`Accepted catalogId ${override.catalogId} requires an immutable subdirectory lock`);
        }
      } else if (override.lock.subdir !== undefined) {
        throw new Error(`Accepted catalogId ${override.catalogId} cannot declare a subdir for a repository-root entry`);
      }
    }
    if (override.lock.kind === "npm") {
      const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
      if (
        typeof override.lock.packageName !== "string" ||
        !semver.test(override.lock.version) ||
        override.lock.resolvedIdentity !== `${override.lock.packageName}@${override.lock.version}` ||
        typeof override.lock.integrity !== "string" ||
        !override.lock.integrity.startsWith("sha512-") ||
        !sha256Pattern.test(override.lock.dependencyGraphSha256) ||
        override.lock.lifecycleScriptsDisabled !== true
      ) {
        throw new Error(`Accepted catalogId ${override.catalogId} requires an exact npm lock and disabled lifecycle scripts`);
      }
    }
    if (
      override?.license?.spdx === "UNKNOWN" ||
      !Array.isArray(override?.license?.obligations) ||
      !["bundle", "managed-local"].includes(override?.license?.distribution)
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires an explicit redistributable license disposition`);
    }
    if (
      override?.audit?.status !== "pass" ||
      !Number.isFinite(Date.parse(override.audit.reviewedAt)) ||
      !Number.isFinite(Date.parse(override.audit.validUntil)) ||
      Date.parse(override.audit.validUntil) <= Date.parse(overrides.releaseAsOf) ||
      typeof override.audit.policyVersion !== "string" ||
      !Array.isArray(override.audit.scanners) ||
      override.audit.scanners.length === 0
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a current passing audit`);
    }
    if (
      override?.windows?.supported !== true ||
      !Array.isArray(override?.windows?.architectures) ||
      override.windows.architectures.length === 0 ||
      override.windows.architectures.some((arch) => !["x64", "arm64"].includes(arch)) ||
      !Number.isInteger(override.windows.minBuild) ||
      override.windows.minBuild < 19045
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires explicit Windows support evidence`);
    }
    if (
      !Array.isArray(override?.permissions?.destructiveActions) ||
      !Array.isArray(override?.permissions?.filesystem) ||
      !Array.isArray(override?.permissions?.secrets) ||
      !["none", "allowlist"].includes(override?.permissions?.network?.mode) ||
      (override.permissions.network.mode === "allowlist" &&
        (!Array.isArray(override.permissions.network.hosts) || override.permissions.network.hosts.length === 0))
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a complete least-privilege permission contract`);
    }
    if (
      typeof override?.artifact?.relativePath !== "string" ||
      !override.artifact.relativePath.startsWith("providers/") ||
      override.artifact.relativePath.includes("..") ||
      override.artifact.relativePath.includes("\\")
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a safe providers/ artifact path`);
    }
    const artifactPath = resolve(projectRoot, ...override.artifact.relativePath.split("/"));
    if (!artifactPath.startsWith(`${providersRoot}${sep}`)) {
      throw new Error(`Accepted catalogId ${override.catalogId} artifact escapes providers/`);
    }
    const artifactBytes = await readFile(artifactPath);
    if (createHash("sha256").update(artifactBytes).digest("hex") !== override.artifact.sha256) {
      throw new Error(`Accepted catalogId ${override.catalogId} artifact hash does not match`);
    }
    if (
      override?.runtime?.transport !== "mcp-stdio" ||
      typeof override?.runtime?.command !== "string" ||
      !Array.isArray(override?.runtime?.args) ||
      !Array.isArray(override?.runtime?.tools)
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires an MCP stdio runtime contract`);
    }
    if (
      override.role !== "local-provider" ||
      !["windows-sandbox", "container-hyperv"].includes(override.runtime.isolation)
    ) {
      throw new Error(`Accepted catalogId ${override.catalogId} requires a supported local-provider role and isolation backend`);
    }
    await verifyBoundEvidence(
      override.lock.evidencePath,
      override.lock.evidenceSha256,
      evidenceRoot,
      `Accepted catalogId ${override.catalogId} source lock`,
      {
        kind: "source-lock",
        catalogId: override.catalogId,
        canonicalUrl: canonicalSource,
        resolvedIdentity: override.lock.resolvedIdentity,
        treeSha256: override.lock.treeSha256,
        artifactSha256: override.artifact.sha256
      }
    );
    await verifyBoundEvidence(
      override.license.evidencePath,
      override.license.evidenceSha256,
      evidenceRoot,
      `Accepted catalogId ${override.catalogId} license evidence`,
      {
        kind: "license-review",
        catalogId: override.catalogId,
        artifactSha256: override.artifact.sha256,
        spdx: override.license.spdx,
        distribution: override.license.distribution
      }
    );
    await verifyBoundEvidence(
      override.audit.reportPath,
      override.audit.reportSha256,
      evidenceRoot,
      `Accepted catalogId ${override.catalogId} audit report`,
      {
        kind: "security-audit",
        catalogId: override.catalogId,
        artifactSha256: override.artifact.sha256,
        status: "pass",
        policyVersion: override.audit.policyVersion,
        validUntil: override.audit.validUntil
      }
    );
    await verifyBoundEvidence(
      override.windows.evidencePath,
      override.windows.evidenceSha256,
      evidenceRoot,
      `Accepted catalogId ${override.catalogId} Windows evidence`,
      {
        kind: "windows-compatibility",
        catalogId: override.catalogId,
        artifactSha256: override.artifact.sha256,
        supported: true,
        architectures: override.windows.architectures,
        minBuild: override.windows.minBuild
      }
    );
  }
  overrideById.set(override.catalogId, override);
}

const acceptedSourceKeys = new Set();
for (const override of overrideById.values()) {
  if (override.releaseState !== "accepted") continue;
  const key = override.lock.kind === "git"
    ? `git:${override.lock.repositoryNodeId}:${override.lock.subdir ?? "."}`
    : `npm:${override.lock.packageName}`;
  if (acceptedSourceKeys.has(key)) {
    throw new Error(`Accepted providers contain a duplicate immutable source key: ${key}`);
  }
  acceptedSourceKeys.add(key);
}

const slugify = (value) => value
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 64);

const inferRole = (resource) => {
  const mode = String(resource.integration_mode ?? "").toLowerCase();
  if (mode.includes("catalog") || mode.includes("installer")) return "catalog-only";
  if (mode.includes("security-gate") || mode.includes("test-harness") || mode.includes("lockfile")) {
    return "build-gate";
  }
  if (mode.includes("adapter")) return "agent-adapter";
  if (mode.includes("remote")) return "remote-connector";
  if (mode.startsWith("normalize")) return "instruction-module";
  return "local-provider";
};

const resources = source.resources.map((resource) => {
  const override = overrideById.get(resource.id);
  const canonicalOverride = canonicalById.get(resource.id);
  const releaseState = override?.releaseState ?? "catalog-only";
  return {
    catalogId: resource.id,
    moduleId: `catalog.${String(resource.id).padStart(3, "0")}.${slugify(resource.name)}`,
    name: resource.name,
    description: resource.description,
    sourceType: resource.source_type,
    originalUrl: resource.url,
    canonicalUrl: canonicalOverride?.canonicalUrl ?? resource.url,
    canonicalization: canonicalOverride ?? null,
    category: resource.category,
    agents: [...(resource.agents ?? [])],
    integrationMode: resource.integration_mode,
    intendedRole: inferRole(resource),
    releaseState,
    acceptance: override ?? {
      releaseState: "catalog-only",
      reason: "Source, license, security, and compatibility have not passed the public release gates."
    }
  };
});

for (const resource of resources) {
  if (
    resource.releaseState === "accepted" &&
    (resource.intendedRole !== "local-provider" || resource.acceptance.role !== resource.intendedRole)
  ) {
    throw new Error(`Accepted catalogId ${resource.catalogId} has a forbidden or mismatched runtime role`);
  }
}
if (new Set(resources.map((resource) => resource.moduleId)).size !== resources.length) {
  throw new Error("Generated module IDs must be unique");
}

const payload = {
  schemaVersion: 1,
  snapshotDate: source.snapshot_date,
  title: source.title,
  targets: source.targets,
  architecture: "federated-meta-plugin",
  sourceSha256: createHash("sha256")
    .update(rawSource)
    .update(JSON.stringify(canonicalOverrides))
    .update(JSON.stringify(overrides))
    .digest("hex"),
  counts: {
    catalogue: resources.length,
    accepted: resources.filter((resource) => resource.releaseState === "accepted").length,
    catalogOnly: resources.filter((resource) => resource.releaseState === "catalog-only").length,
    quarantined: resources.filter((resource) => resource.releaseState === "quarantined").length,
    referenceOnly: resources.filter((resource) => resource.releaseState === "reference-only").length
  },
  resources
};

const runtimePayload = {
  schemaVersion: 1,
  generatedFrom: payload.sourceSha256,
  providers: resources
    .filter((resource) => resource.releaseState === "accepted")
    .map((resource) => ({
      catalogId: resource.catalogId,
      moduleId: resource.moduleId,
      name: resource.name,
      agents: resource.agents,
      role: resource.intendedRole,
      artifact: resource.acceptance.artifact,
      runtime: resource.acceptance.runtime,
      permissions: resource.acceptance.permissions,
      windows: resource.acceptance.windows
    }))
};

await mkdir(dirname(generatedOutputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await writeFile(runtimeOutputPath, `${JSON.stringify(runtimePayload, null, 2)}\n`, "utf8");
await writeFile(
  generatedOutputPath,
  `// Generated by scripts/compile-catalog.mjs. Do not edit.\nexport const compiledCatalog = ${JSON.stringify(payload, null, 2)};\n`,
  "utf8"
);
await writeFile(
  generatedRuntimeOutputPath,
  `// Generated by scripts/compile-catalog.mjs. Do not edit.\nexport const compiledRuntimeRegistry = ${JSON.stringify(runtimePayload, null, 2)};\n`,
  "utf8"
);
process.stdout.write(
  `Compiled ${payload.counts.catalogue} catalogue entries (${payload.counts.accepted} accepted providers)\n`
);
