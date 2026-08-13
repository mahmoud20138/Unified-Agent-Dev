import { createHash, verify as verifySignature } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface ReleaseFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: "unified-agent-dev";
  version: string;
  channel: "development" | "public";
  generatedAt: string;
  catalogSha256: string;
  acceptedProviders: number;
  files: ReleaseFile[];
  signature: null | {
    algorithm: "Ed25519";
    keyId: string;
    valueBase64: string;
  };
}

// Public release keys are pinned in the shipped verifier. Development release 0.1.0
// intentionally has no trusted key and therefore cannot pass public installation.
const trustedReleaseKeys: Readonly<Record<string, string>> = Object.freeze({});

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalManifestPayload(manifest: ReleaseManifest): Buffer {
  const { signature: _signature, ...payload } = manifest;
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  };
  return Buffer.from(stable(payload));
}

async function walkFiles(root: string, path = root): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...await walkFiles(root, child));
    else if (entry.isFile()) output.push(relative(root, child).split(sep).join("/"));
    else throw new Error(`Release verification rejects links and special files: ${child}`);
  }
  return output.sort();
}

export async function readReleaseManifest(root: string): Promise<ReleaseManifest> {
  return JSON.parse(
    await readFile(resolve(root, "release", "release.manifest.json"), "utf8")
  ) as ReleaseManifest;
}

export async function verifyRelease(
  root: string,
  options: { allowUnsignedDevelopment?: boolean; strictFileSet?: boolean } = {}
): Promise<ReleaseManifest> {
  const manifest = await readReleaseManifest(root);
  if (manifest.schemaVersion !== 1 || manifest.product !== "unified-agent-dev") {
    throw new Error("Unsupported release manifest");
  }
  if (!manifest.signature) {
    if (manifest.channel !== "development" || options.allowUnsignedDevelopment !== true) {
      throw new Error(
        "Release is unsigned. Public installation is blocked; pass --allow-unsigned-development only for a local development build."
      );
    }
  } else {
    const publicKey = trustedReleaseKeys[manifest.signature.keyId];
    if (!publicKey) throw new Error(`Release signing key ${manifest.signature.keyId} is not trusted`);
    const valid = verifySignature(
      null,
      canonicalManifestPayload(manifest),
      publicKey,
      Buffer.from(manifest.signature.valueBase64, "base64")
    );
    if (!valid) throw new Error(`Release signature ${manifest.signature.keyId} is invalid`);
  }
  const uniquePaths = new Set(manifest.files.map((file) => file.path));
  if (uniquePaths.size !== manifest.files.length) throw new Error("Release manifest contains duplicate paths");
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9._/-]+$/.test(file.path) || file.path.includes("..") || file.path.startsWith("/")) {
      throw new Error(`Unsafe release manifest path: ${file.path}`);
    }
    const bytes = await readFile(resolve(root, ...file.path.split("/")));
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Release integrity check failed for ${file.path}`);
    }
  }
  if (options.strictFileSet) {
    const actual = (await walkFiles(root)).filter((path) => path !== "release/release.manifest.json");
    const expected = [...uniquePaths].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const extras = actual.filter((path) => !uniquePaths.has(path));
      const missing = expected.filter((path) => !actual.includes(path));
      throw new Error(`Release file set mismatch; extra=[${extras.join(",")}], missing=[${missing.join(",")}]`);
    }
  }
  return manifest;
}
