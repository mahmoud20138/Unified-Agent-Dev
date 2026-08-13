import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("catalogue compiler rejects assertion-only provider acceptance", async () => {
  const smokeRoot = resolve(projectRoot, ".install-smoke");
  await mkdir(smokeRoot, { recursive: true });
  const fixture = await mkdtemp(resolve(smokeRoot, "admission-"));
  await mkdir(resolve(fixture, "scripts"), { recursive: true });
  await mkdir(resolve(fixture, "catalog"), { recursive: true });
  try {
    await cp(resolve(projectRoot, "scripts", "compile-catalog.mjs"), resolve(fixture, "scripts", "compile-catalog.mjs"));
    await cp(resolve(projectRoot, "catalog", "source.yaml"), resolve(fixture, "catalog", "source.yaml"));
    await cp(
      resolve(projectRoot, "catalog", "canonical-overrides.json"),
      resolve(fixture, "catalog", "canonical-overrides.json")
    );
    const source = JSON.parse(await readFile(resolve(projectRoot, "catalog", "catalog.json"), "utf8"));
    const entry = source.resources[92];
    await writeFile(
      resolve(fixture, "catalog", "acceptance-overrides.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        releaseAsOf: "2026-08-13T00:00:00.000Z",
        providers: [{
          catalogId: 93,
          releaseState: "accepted",
          role: "local-provider",
          lock: {
            kind: "git",
            sourceType: entry.sourceType,
            canonicalUrl: entry.canonicalUrl,
            resolvedIdentity: "latest",
            treeSha256: "x",
            evidenceSha256: "x"
          },
          license: { spdx: "UNKNOWN", evidenceSha256: "x" },
          audit: { reportSha256: "x", reviewedAt: "never", reviewer: "nobody" },
          windows: { supported: true, architectures: [] },
          permissions: { destructiveActions: [], network: "anything" }
        }]
      }, null, 2)}\n`,
      "utf8"
    );
    const result = spawnSync(process.execPath, [resolve(fixture, "scripts", "compile-catalog.mjs")], {
      cwd: fixture,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /requires a lowercase SHA-256/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
