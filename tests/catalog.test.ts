import assert from "node:assert/strict";
import test from "node:test";
import { listResources, loadCatalog, resolveCapability, searchResources } from "../src/catalog.js";

test("compiled catalogue has exactly 100 ordered entries and zero accepted providers", async () => {
  const catalog = await loadCatalog();
  assert.equal(catalog.resources.length, 100);
  assert.deepEqual(catalog.resources.map((resource) => resource.catalogId),
    Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(catalog.counts.accepted, 0);
  assert.equal((await listResources({ releaseState: "accepted" })).length, 0);
});

test("known redirects are canonicalized without changing the original research URL", async () => {
  const catalog = await loadCatalog();
  const expected = new Map([
    [42, "https://github.com/coderamp-labs/gitingest"],
    [72, "https://github.com/supabase/mcp"],
    [82, "https://github.com/googleapis/mcp-toolbox"],
    [86, "https://github.com/The-PR-Agent/pr-agent"],
    [98, "https://github.com/ccusage/ccusage"]
  ]);
  for (const [id, url] of expected) {
    const entry = catalog.resources.find((resource) => resource.catalogId === id);
    assert.equal(entry?.canonicalUrl, url);
    assert.notEqual(entry?.originalUrl, entry?.canonicalUrl);
  }
});

test("search is deterministic and resolver fails closed for unaccepted matches", async () => {
  const first = await searchResources("MCP workflow", { limit: 10 });
  const second = await searchResources("MCP workflow", { limit: 10 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  const resolution = await resolveCapability("MCP workflow");
  assert.equal(resolution.status, "catalog-only");
  assert.equal(resolution.selected, undefined);
});
