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
source = "${tomlString(bundleRoot)}"
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

process.stdout.write(`${JSON.stringify({ status: "installed", dryRun, codexHome, configPath, backupPath: dryRun ? null : backupPath, pluginRoot, cliPath: cliPath || null, removedPluginCaches }, null, 2)}\n`);
