import { compiledCatalog } from "./generated/catalog.js";
import { compiledRuntimeRegistry } from "./generated/runtime.js";
import type {
  CatalogResource,
  CompiledCatalog,
  ReleaseState,
  RuntimeRegistry,
  SearchOptions,
  SearchResult
} from "./types.js";

let cachedCatalog: CompiledCatalog | undefined;
let cachedRuntime: RuntimeRegistry | undefined;

export async function loadCatalog(): Promise<CompiledCatalog> {
  if (cachedCatalog) return cachedCatalog;
  const parsed = compiledCatalog as unknown as CompiledCatalog;
  validateCompiledCatalog(parsed);
  cachedCatalog = parsed;
  return parsed;
}

export async function loadRuntimeRegistry(): Promise<RuntimeRegistry> {
  if (cachedRuntime) return cachedRuntime;
  const runtime = compiledRuntimeRegistry as unknown as RuntimeRegistry;
  const catalog = await loadCatalog();
  if (runtime.schemaVersion !== 1 || runtime.generatedFrom !== catalog.sourceSha256) {
    throw new Error("Runtime registry is not derived from the active catalogue");
  }
  const acceptedIds = catalog.resources
    .filter((resource) => resource.releaseState === "accepted")
    .map((resource) => resource.moduleId)
    .sort();
  const providerIds = runtime.providers.map((provider) => provider.moduleId).sort();
  if (new Set(providerIds).size !== providerIds.length || JSON.stringify(providerIds) !== JSON.stringify(acceptedIds)) {
    throw new Error("Runtime registry is not the exact accepted-provider projection");
  }
  cachedRuntime = runtime;
  return runtime;
}

export function validateCompiledCatalog(catalog: CompiledCatalog): void {
  if (catalog.schemaVersion !== 1 || catalog.architecture !== "federated-meta-plugin") {
    throw new Error("Unsupported compiled catalogue schema");
  }
  if (catalog.resources.length !== 100 || catalog.counts.catalogue !== 100) {
    throw new Error("The research catalogue must contain exactly 100 entries");
  }
  for (const field of ["catalogId", "moduleId"] as const) {
    const values = catalog.resources.map((resource) => resource[field]);
    if (new Set(values).size !== values.length) {
      throw new Error(`Compiled catalogue field ${field} must be unique`);
    }
  }
  const expectedIds = Array.from({ length: 100 }, (_, index) => index + 1);
  if (catalog.resources.some((resource, index) => resource.catalogId !== expectedIds[index])) {
    throw new Error("Compiled catalogue IDs must be the ordered integers 1 through 100");
  }
  const accepted = catalog.resources.filter((resource) => resource.releaseState === "accepted").length;
  if (accepted !== catalog.counts.accepted) {
    throw new Error("Compiled catalogue accepted count is inconsistent");
  }
}

const normalize = (value: string): string => value.toLowerCase().normalize("NFKD");
const tokenize = (value: string): string[] => normalize(value).split(/[^a-z0-9]+/).filter(Boolean);

export async function listResources(options: SearchOptions = {}): Promise<CatalogResource[]> {
  const catalog = await loadCatalog();
  const agent = options.agent ? normalize(options.agent) : undefined;
  return catalog.resources
    .filter((resource) => !options.releaseState || resource.releaseState === options.releaseState)
    .filter((resource) => !agent || resource.agents.some((candidate) => normalize(candidate) === agent))
    .slice(0, options.limit ?? 100);
}

export async function searchResources(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const candidates = await listResources({ ...options, limit: 100 });
  const results = candidates.map((resource) => {
    const name = normalize(resource.name);
    const category = normalize(resource.category);
    const description = normalize(resource.description);
    const agents = normalize(resource.agents.join(" "));
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 8;
      if (category.includes(term)) score += 5;
      if (agents.includes(term)) score += 3;
      if (description.includes(term)) score += 2;
    }
    if (resource.releaseState === "accepted") score += 1;
    return { resource, score };
  });
  return results
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score || left.resource.catalogId - right.resource.catalogId)
    .slice(0, options.limit ?? 10);
}

export async function resolveCapability(query: string): Promise<{
  status: "available" | "catalog-only" | "not-found";
  selected?: CatalogResource;
  candidates: SearchResult[];
  message: string;
}> {
  const candidates = await searchResources(query, { limit: 10 });
  const runtime = await loadRuntimeRegistry();
  const executableIds = new Set(runtime.providers.map((provider) => provider.moduleId));
  const accepted = candidates.find((candidate) => executableIds.has(candidate.resource.moduleId));
  if (accepted) {
    return {
      status: "available",
      selected: accepted.resource,
      candidates,
      message: `Selected accepted provider ${accepted.resource.name}.`
    };
  }
  if (candidates.length > 0) {
    return {
      status: "catalog-only",
      candidates,
      message: "Matching research sources exist, but none has passed the public release gates."
    };
  }
  return {
    status: "not-found",
    candidates: [],
    message: "No matching capability exists in the 100-source research catalogue."
  };
}

export function isExecutableReleaseState(state: ReleaseState): boolean {
  return state === "accepted";
}
