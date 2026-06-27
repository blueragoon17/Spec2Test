#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), "..");
const errors = [];
const placeholderPattern = new RegExp(`${"perfectone"}\\.${"local"}|${"Pro" + "prietary"}`, "i");
const required = [
  ".codex-plugin/plugin.json",
  ".mcp.json",
  "mcp-server/src/server.js",
  "skills/perfectone-c-unit-verify/SKILL.md",
  "schemas/perfectone.unitverify.v1.schema.json",
  "samples/c-input04-complex/sample1.c",
  "samples/c-basic-control/sample2.c",
  "README.md",
  "LICENSE",
  "NOTICE",
  "VERSION.txt"
];
for (const rel of required) {
  if (!existsSync(path.join(root, rel))) errors.push(`missing required file: ${rel}`);
}

const forbiddenDirs = new Set(["PerfectOne_CLI_source", "Output", ".perfectone", "node_modules"]);
const forbiddenExt = new Set([".exe", ".dll", ".pdb", ".obj", ".lib", ".ktest", ".profraw", ".profdata"]);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (forbiddenDirs.has(entry.name)) errors.push(`forbidden directory in release: ${rel}`);
      walk(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (forbiddenExt.has(ext)) errors.push(`forbidden binary/artifact in release: ${rel}`);
    if (statSync(full).size > 5 * 1024 * 1024) errors.push(`unexpected large file over 5MB: ${rel}`);
    if (rel !== "scripts/check-release.mjs" && [".json", ".md", ".mjs", ".js", ".ps1", ".sh"].includes(ext)) {
      const text = readFileSync(full, "utf8");
      if (placeholderPattern.test(text)) errors.push(`placeholder local/proprietary metadata remains in: ${rel}`);
    }
  }
}
walk(root);

const plugin = JSON.parse(readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
if (plugin.version !== "0.2.0-beta.1") errors.push(`plugin version mismatch: ${plugin.version}`);

const readme = readFileSync(path.join(root, "README.md"), "utf8");
for (const needle of ["samples/c-input04-complex/sample1.c", "samples/c-basic-control/sample2.c", "Embedded targets are not validated", "PerfectOne CLI binaries"]) {
  if (!readme.includes(needle)) errors.push(`README missing required text: ${needle}`);
}

if (errors.length) {
  console.error(JSON.stringify({ status: "failed", errors }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: "passed", checkedRoot: root }, null, 2));
