#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function removeSection(text, header) {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^${escaped}\\r?\\n.*?(?=^\\[|\\z)`, "gms"), "");
}

function removeSkillLink(linkPath, force) {
  if (!existsSync(linkPath)) return { path: linkPath, removed: false, reason: "missing" };
  const stat = lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    if (!force) return { path: linkPath, removed: false, reason: "not_symlink" };
    rmSync(linkPath, { recursive: true, force: true });
    return { path: linkPath, removed: true, reason: "force_removed" };
  }
  rmSync(linkPath, { force: true });
  return { path: linkPath, removed: true };
}

function removePluginCaches(home, dry) {
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
    removed.push({ path: candidate, removed: !dry, reason: dry ? "dry_run" : "plugin_cache_removed" });
  }
  return removed;
}

const codexHome = path.resolve(argValue(["--codexHome", "--codex-home"], path.join(os.homedir(), ".codex")));
const forceSkillRemoval = hasFlag(["--forceSkillRemoval", "--force-skill-removal"]);
const dryRun = hasFlag(["--dryRun", "--dry-run"]);
const configPath = path.join(codexHome, "config.toml");
const removedLinks = [];
const removedPluginCaches = removePluginCaches(codexHome, dryRun);
let backupPath = null;

if (existsSync(configPath)) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  backupPath = `${configPath}.bak.before-perfectone-unit-verify-uninstall-${stamp}`;
  let text = readFileSync(configPath, "utf8");
  for (const header of [
    "[mcp_servers.perfectone-unit-verify]",
    "[mcp_servers.perfectone-unit-verify.env]",
    "[marketplaces.perfectone-local]",
    "[marketplaces.perfectone-local-marketplace]",
    '[plugins."perfectone-unit-verify@perfectone-local-marketplace"]',
    '[plugins."perfectone-unit-verify@perfectone-local"]'
  ]) {
    text = removeSection(text, header);
  }
  if (!dryRun) {
    copyFileSync(configPath, backupPath);
    writeFileSync(configPath, `${text.trimEnd()}\n`, "utf8");
  }
}

if (!dryRun) {
  for (const skill of ["perfectone-c-unit-verify", "general-unit-verify", "unit-design-verify"]) {
    removedLinks.push(removeSkillLink(path.join(codexHome, "skills", skill), forceSkillRemoval));
  }
}

process.stdout.write(`${JSON.stringify({ status: "uninstalled", dryRun, codexHome, configPath, backupPath: dryRun ? null : backupPath, bundleRoot, removedLinks, removedPluginCaches }, null, 2)}\n`);
