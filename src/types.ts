export type ReleaseState = "accepted" | "catalog-only" | "quarantined" | "reference-only";
export type CatalogRole =
  | "catalog-only"
  | "instruction-module"
  | "local-provider"
  | "remote-connector"
  | "agent-adapter"
  | "build-gate"
  | "reference-only";

export interface CatalogResource {
  catalogId: number;
  moduleId: string;
  name: string;
  description: string;
  sourceType: string;
  originalUrl: string;
  canonicalUrl: string;
  canonicalization: Record<string, unknown> | null;
  category: string;
  agents: string[];
  integrationMode: string;
  intendedRole: CatalogRole;
  releaseState: ReleaseState;
  acceptance: Record<string, unknown>;
}

export interface CompiledCatalog {
  schemaVersion: 1;
  snapshotDate: string;
  title: string;
  targets: string[];
  architecture: "federated-meta-plugin";
  sourceSha256: string;
  counts: {
    catalogue: number;
    accepted: number;
    catalogOnly: number;
    quarantined: number;
    referenceOnly: number;
  };
  resources: CatalogResource[];
}

export interface SearchOptions {
  limit?: number;
  agent?: string;
  releaseState?: ReleaseState;
}

export interface SearchResult {
  resource: CatalogResource;
  score: number;
}

export interface RuntimeProvider {
  catalogId: number;
  moduleId: string;
  name: string;
  agents: string[];
  role: "local-provider";
  artifact: { relativePath: string; sha256: string };
  runtime: {
    transport: "mcp-stdio";
    command: string;
    args: string[];
    tools: string[];
    isolation: "windows-sandbox" | "container-hyperv";
  };
  permissions: Record<string, unknown>;
  windows: Record<string, unknown>;
}

export interface RuntimeRegistry {
  schemaVersion: 1;
  generatedFrom: string;
  providers: RuntimeProvider[];
}
