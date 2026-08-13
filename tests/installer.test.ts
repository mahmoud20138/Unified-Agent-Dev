import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import { doctorProduct, installProduct, resolveHostCommand } from "../src/installer.js";

async function missing(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

test("unsigned development releases are blocked unless explicitly allowed", { skip: process.platform !== "win32" }, async () => {
  const home = await mkdtemp(resolve(tmpdir(), "unified-agent-unsigned-"));
  try {
    await assert.rejects(
      installProduct({ home, agents: [], skipHostCommands: true }),
      /unsigned/i
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows install is transactional and rollback restores OpenCode configuration", { skip: process.platform !== "win32" }, async () => {
  const base = await mkdtemp(resolve(tmpdir(), "unified-agent-path-"));
  const home = resolve(base, "User With Spaces Ω");
  const configPath = resolve(home, ".config", "opencode", "opencode.jsonc");
  const original = `{
  // Preserve this user comment.
  "theme": "system",
  "plugin": ["existing@example"],
}\n`;
  await mkdir(resolve(home, ".config", "opencode"), { recursive: true });
  await writeFile(configPath, original, "utf8");
  try {
    const installed = await installProduct({
      home,
      agents: ["opencode"],
      skipHostCommands: true,
      allowUnsignedDevelopment: true
    });
    assert.equal(installed.status, "installed");
    const managedText = await readFile(configPath, "utf8");
    assert.match(managedText, /Preserve this user comment/);
    const config = parse(managedText);
    assert.equal(config.theme, "system");
    assert.deepEqual(config.plugin, ["existing@example"]);
    assert.deepEqual(config.mcp["unified-agent-dev"].command.slice(0, 1), [process.execPath]);
    assert.match(config.mcp["unified-agent-dev"].command[1], /\.unified-agent-dev[\\/]releases[\\/]0\.1\.0/);

    const doctor = await doctorProduct(home);
    assert.equal(doctor.healthy, true);
    assert.ok((doctor.checks as Array<{ name: string; ok: boolean }>).some(
      (check) => check.name === "release-integrity" && check.ok
    ));

    const installedCli = resolve(installed.releaseRoot, "runtime", "cli.mjs");
    const cliDoctor = spawnSync(process.execPath, [installedCli, "doctor", "--home", home], {
      encoding: "utf8"
    });
    assert.equal(cliDoctor.status, 0, cliDoctor.stderr);
    assert.equal(JSON.parse(cliDoctor.stdout).healthy, true);
    const rollbackResult = spawnSync(process.execPath, [installedCli, "rollback", "--home", home], {
      encoding: "utf8"
    });
    assert.equal(rollbackResult.status, 0, rollbackResult.stderr);
    const rolledBack = JSON.parse(rollbackResult.stdout);
    assert.deepEqual(rolledBack.conflicts, []);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(await missing(resolve(home, ".unified-agent-dev", "current.json")), true);
    assert.equal(await missing(installed.releaseRoot), true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("Windows host shims resolve to safely spawnable native commands", { skip: process.platform !== "win32" }, (context) => {
  let detected = 0;
  for (const host of ["codex", "claude", "opencode"]) {
    const command = resolveHostCommand(host);
    if (!command) continue;
    detected += 1;
    const probe = spawnSync(command.executable, [...command.prefixArgs, "--version"], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(probe.status, 0, `${host}: ${probe.error?.message ?? probe.stderr}`);
  }
  if (detected === 0) context.skip("no supported host CLI is installed");
});

test("rollback conflicts are non-destructive and retryable", { skip: process.platform !== "win32" }, async () => {
  const home = await mkdtemp(resolve(tmpdir(), "unified-agent-conflict-"));
  const configPath = resolve(home, ".config", "opencode", "opencode.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, "{}\n", "utf8");
  try {
    const installed = await installProduct({
      home,
      agents: ["opencode"],
      skipHostCommands: true,
      allowUnsignedDevelopment: true
    });
    const managed = await readFile(configPath);
    await writeFile(configPath, `${managed.toString("utf8").trimEnd()}\n// user changed after install\n`, "utf8");
    const cli = resolve(installed.releaseRoot, "runtime", "cli.mjs");
    const first = spawnSync(process.execPath, [cli, "rollback", "--home", home], { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(JSON.parse(first.stdout).conflicts.includes(configPath));
    assert.equal(await missing(installed.releaseRoot), false);
    await writeFile(configPath, managed);
    const second = spawnSync(process.execPath, [cli, "rollback", "--home", home], { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).conflicts, []);
    assert.equal(await missing(installed.releaseRoot), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("doctor rejects unmanifested files in an installed plugin", { skip: process.platform !== "win32" }, async () => {
  const home = await mkdtemp(resolve(tmpdir(), "unified-agent-extra-file-"));
  try {
    const installed = await installProduct({
      home,
      agents: [],
      skipHostCommands: true,
      allowUnsignedDevelopment: true
    });
    const injected = resolve(
      installed.releaseRoot,
      "plugins",
      "unified-agent-dev",
      "skills",
      "injected",
      "SKILL.md"
    );
    await mkdir(resolve(injected, ".."), { recursive: true });
    await writeFile(injected, "---\nname: injected\n---\n", "utf8");
    const doctor = await doctorProduct(home);
    assert.equal(doctor.healthy, false);
    assert.match(JSON.stringify(doctor), /file set mismatch/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
