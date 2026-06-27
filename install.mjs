#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const bundleRoot = path.dirname(__filename);

function argValue(names, fallback = null) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1];
  }
  return fallback;
}

function hasFlag(names) {
  return (Array.isArray(names) ? names : [names]).some((name) => process.argv.includes(name));
}

function tomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function removeSection(text, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\r?\\n.*?(?=^\\[|\\z)`, "gms"), "");
}

function upsertBlock(text, headers, block) {
  let next = text;
  for (const header of headers) next = removeSection(next, header);
  const trimmed = next.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ""}${block.trim()}\n`;
}

function cliCandidates(root) {
  const platform = process.platform === "win32" ? "windows" : (process.platform === "darwin" ? "macos" : "linux");
  const source = path.join(root, "bin");
  const byPlatform = {
    windows: [path.join(source, "windows", "ClangParserForWin.exe")],
    linux: [path.join(source, "linux", "ClangParserForLinux")],
    macos: [path.join(source, "macos", "ClangParserForMac")]
  };
  return byPlatform[platform] || [];
}

function linkSkill(linkPath, target) {
  if (existsSync(linkPath)) {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) throw new Error(`Install target exists and is not a skill link: ${linkPath}`);
    rmSync(linkPath, { force: true });
  }
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function replaceDirectoryLink(linkPath, target, dry) {
  if (existsSync(linkPath)) {
    if (!dry) rmSync(linkPath, { recursive: true, force: true });
  }
  if (!dry) {
    mkdirSync(path.dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }
}

function ensureLocalMarketplaceRoot(home, root, dry) {
  const marketplaceRoot = path.join(home, "plugins", "local-marketplaces", "perfectone");
  const marketplacePath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  const marketplacePluginPath = path.join(marketplaceRoot, "plugins", "perfectone-unit-verify");
  const marketplace = {
    name: "perfectone-local",
    interface: {
      displayName: "PerfectOne Local"
    },
    plugins: [
      {
        name: "perfectone-unit-verify",
        source: {
          source: "local",
          path: "./plugins/perfectone-unit-verify"
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Engineering"
      }
    ]
  };
  if (!dry) {
    mkdirSync(path.dirname(marketplacePath), { recursive: true });
    writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
    replaceDirectoryLink(marketplacePluginPath, root, dry);
  }
  return { marketplaceRoot, marketplacePath, marketplacePluginPath };
}

function codexCommandSupports(args, pattern) {
  const result = spawnSync("codex", args, { encoding: "utf8", shell: process.platform === "win32" });
  if ((result.status ?? 1) !== 0) return false;
  return pattern.test(`${result.stdout || ""}\n${result.stderr || ""}`);
}

function runCodexCommand(args, dry) {
  if (dry) return { command: `codex ${args.join(" ")}`, exitCode: 0, stdout: "", stderr: "", dryRun: true };
  const result = spawnSync("codex", args, { encoding: "utf8", shell: process.platform === "win32" });
  return {
    command: `codex ${args.join(" ")}`,
    exitCode: result.status ?? null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    dryRun: false
  };
}

function runMarketplaceAdd(marketplaceRoot, marketplaceName, dry) {
  const initialAdd = runCodexCommand(["plugin", "marketplace", "add", marketplaceRoot], dry);
  if (initialAdd.exitCode === 0 || !/already added from a different source/i.test(initialAdd.stderr || "")) {
    return initialAdd;
  }
  const remove = runCodexCommand(["plugin", "marketplace", "remove", marketplaceName], dry);
  const retryAdd = remove.exitCode === 0
    ? runCodexCommand(["plugin", "marketplace", "add", marketplaceRoot], dry)
    : null;
  return {
    ...(retryAdd || initialAdd),
    recoveredDifferentSource: Boolean(retryAdd && retryAdd.exitCode === 0),
    recovery: {
      initialAdd,
      remove,
      retryAdd
    }
  };
}

function runCodexPluginRegistration(marketplaceRoot, dry) {
  const marketplaceName = "perfectone-local";
  const codexAvailable = spawnSync("codex", ["--help"], { encoding: "utf8", shell: process.platform === "win32" });
  if ((codexAvailable.status ?? 1) !== 0) {
    return { attempted: false, method: "config-fallback", reason: "codex-cli-not-found" };
  }
  const marketplaceAddSupported = codexCommandSupports(["plugin", "marketplace", "--help"], /\badd\b/);
  const marketplaceAdd = marketplaceAddSupported
    ? runMarketplaceAdd(marketplaceRoot, marketplaceName, dry)
    : null;
  const pluginAddSupported = codexCommandSupports(["plugin", "--help"], /\badd\b/);
  if (pluginAddSupported) {
    const pluginAdd = runCodexCommand(["plugin", "add", "perfectone-unit-verify@perfectone-local"], dry);
    return {
      attempted: true,
      method: "codex-plugin-add",
      marketplaceAdd,
      pluginAdd,
      exitCode: pluginAdd.exitCode,
      stdout: pluginAdd.stdout,
      stderr: pluginAdd.stderr
    };
  }
  if (marketplaceAddSupported) {
    return {
      attempted: true,
      method: "config-fallback",
      marketplaceAdd,
      reason: "codex-plugin-add-unavailable"
    };
  }
  return { attempted: false, method: "config-fallback", reason: "codex-plugin-commands-unavailable" };
}

function removeStalePluginCaches(home, dry) {
  const cacheRoot = path.join(home, "plugins", "cache");
  const candidates = [
    path.join(cacheRoot, "perfectone-local-marketplace", "perfectone-unit-verify"),
    path.join(cacheRoot, "perfectone-local", "perfectone-unit-verify")
  ];
  const removed = [];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      removed.push({ path: candidate, removed: false, reason: "missing" });
      continue;
    }
    if (!dry) rmSync(candidate, { recursive: true, force: true });
    removed.push({ path: candidate, removed: !dry, reason: dry ? "dry_run" : "stale_cache_removed" });
  }
  return removed;
}

const codexHome = path.resolve(argValue(["--codexHome", "--codex-home"], path.join(os.homedir(), ".codex")));
const skipSkillLinks = hasFlag(["--skipSkillLinks", "--skip-skill-links"]);
const skipDoctor = hasFlag(["--skipDoctor", "--skip-doctor"]);
const dryRun = hasFlag(["--dryRun", "--dry-run"]);
const skipCodexPluginCli = hasFlag(["--skipCodexPluginCli", "--skip-codex-plugin-cli"]);
const pluginRoot = bundleRoot;
const serverPath = path.join(pluginRoot, "mcp-server", "src", "server.js");
const doctorPath = path.join(pluginRoot, "scripts", "doctor.mjs");
const cliPath = cliCandidates(bundleRoot).find((candidate) => existsSync(candidate)) || "";

for (const required of [serverPath, doctorPath, path.join(pluginRoot, ".codex-plugin", "plugin.json")]) {
  if (!existsSync(required)) throw new Error(`Required file not found: ${required}`);
}

const configPath = path.join(codexHome, "config.toml");
if (!dryRun) {
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(codexHome, "skills"), { recursive: true });
  if (!existsSync(configPath)) writeFileSync(configPath, "", "utf8");
}
const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
const backupPath = `${configPath}.bak.before-perfectone-unit-verify-install-${stamp}`;
let configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const removedPluginCaches = removeStalePluginCaches(codexHome, dryRun);
const localMarketplace = ensureLocalMarketplaceRoot(codexHome, pluginRoot, dryRun);
const codexPluginRegistration = skipCodexPluginCli
  ? { attempted: false, method: "config-fallback", reason: "skipped-by-user" }
  : runCodexPluginRegistration(localMarketplace.marketplaceRoot, dryRun);
const envLines = [`PERFECTONE_WORKSPACE_ROOT = "${tomlString(bundleRoot)}"`];
if (cliPath) envLines.push(`PERFECTONE_CLI = "${tomlString(cliPath)}"`);
const mcpBlock = `
[mcp_servers.perfectone-unit-verify]
command = "node"
args = ["${tomlString(serverPath)}"]

[mcp_servers.perfectone-unit-verify.env]
${envLines.join("\n")}
`;
const marketBlock = `
[marketplaces.perfectone-local]
last_updated = "${new Date().toISOString()}"
source_type = "local"
source = "${tomlString(localMarketplace.marketplaceRoot)}"
`;
const pluginBlock = `
[plugins."perfectone-unit-verify@perfectone-local"]
enabled = true
`;
configText = upsertBlock(configText, ["[mcp_servers.perfectone-unit-verify]", "[mcp_servers.perfectone-unit-verify.env]"], mcpBlock);
configText = upsertBlock(configText, ["[marketplaces.perfectone-local]", "[marketplaces.perfectone-local-marketplace]"], marketBlock);
configText = upsertBlock(configText, ['[plugins."perfectone-unit-verify@perfectone-local"]', '[plugins."perfectone-unit-verify@perfectone-local-marketplace"]'], pluginBlock);

if (!dryRun) {
  copyFileSync(configPath, backupPath);
  writeFileSync(configPath, configText, "utf8");
  if (!skipSkillLinks) {
    for (const skill of ["perfectone-c-unit-verify", "general-unit-verify", "unit-design-verify"]) {
      linkSkill(path.join(codexHome, "skills", skill), path.join(pluginRoot, "skills", skill));
    }
  }
  if (!skipDoctor) {
    const result = spawnSync(process.execPath, [doctorPath, "--workspaceRoot", bundleRoot, "--codexHome", codexHome], { stdio: "inherit" });
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
  }
}

process.stdout.write(`${JSON.stringify({ status: "installed", dryRun, codexHome, configPath, backupPath: dryRun ? null : backupPath, pluginRoot, cliPath: cliPath || null, localMarketplace, codexPluginRegistration, removedPluginCaches }, null, 2)}\n`);
