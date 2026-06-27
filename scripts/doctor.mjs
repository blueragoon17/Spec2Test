#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..");
const defaultWorkspaceRoot = pluginRoot;
const PREPARED_KLEE_DOCKER_IMAGE = "perfectone/klee-coverage-tools:llvm18-lcov-v1";
const BASE_KLEE_DOCKER_IMAGE = "klee/klee:v3.2";
const DOCKER_PREP_ESTIMATE = "usually 10-20 minutes, up to about 30 minutes depending on network and Docker cache state";

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function normalizeHostOs(value) {
  const raw = String(value || process.platform).toLowerCase();
  if (raw === "win32" || raw === "windows") return "windows";
  if (raw === "darwin" || raw === "mac" || raw === "macos") return "macos";
  return raw;
}

function findTool(name) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const completed = spawnSync(lookup, [name], { encoding: "utf8", timeout: 5000 });
  return completed.status === 0 ? `${completed.stdout || ""}`.split(/\r?\n/).find(Boolean) || null : null;
}

function envFlagEnabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ""));
}

function inspectDockerImage(dockerCommand, image) {
  if (!dockerCommand || !image) return { image, exists: false, checked: false, exitCode: null, error: null };
  const completed = spawnSync(dockerCommand, ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  return {
    image,
    exists: completed.status === 0,
    checked: true,
    exitCode: completed.status ?? null,
    error: completed.status === 0 ? null : `${completed.stderr || completed.stdout || ""}`.slice(0, 1000)
  };
}

function dockerPreparationStatus(hostOs, dockerCommand, dockerRequired = false) {
  const configuredImage = String(process.env.PERFECTONE_KLEE_IMAGE || "").trim() || null;
  const cacheDisabled = envFlagEnabled("PERFECTONE_DISABLE_DOCKER_IMAGE_CACHE");
  const installCommand = hostOs === "windows"
    ? "winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements"
    : (hostOs === "macos" ? "brew install --cask docker" : "Install Docker Engine with your distribution package manager, then start the Docker daemon.");
  const status = {
    requiredForWindowsC: hostOs === "windows" && dockerRequired,
    preparedImage: PREPARED_KLEE_DOCKER_IMAGE,
    baseImage: BASE_KLEE_DOCKER_IMAGE,
    configuredImage,
    cacheDisabled,
    estimatedFirstPrepareTime: DOCKER_PREP_ESTIMATE,
    installCommand,
    setupCommands: [
      "docker pull klee/klee:v3.2",
      `docker image inspect ${PREPARED_KLEE_DOCKER_IMAGE}`
    ],
    dockerAvailable: Boolean(dockerCommand),
    dockerCommand,
    preparedImagePresent: null,
    baseImagePresent: null,
    firstRunWillPrepare: false,
    repeatedPrepareLikely: false,
    checked: false,
    status: "not_required",
    message: "Docker prepared image is not required for this host."
  };
  if (hostOs !== "windows" || !dockerRequired) return status;
  if (!dockerCommand) {
    return {
      ...status,
      status: "docker_unavailable",
      message: `Windows C coverage defaults to Docker for PerfectOne KLEE execution, but Docker was not found. Install Docker Desktop before running C coverage: ${installCommand}`
    };
  }
  const prepared = inspectDockerImage(dockerCommand, PREPARED_KLEE_DOCKER_IMAGE);
  const base = inspectDockerImage(dockerCommand, BASE_KLEE_DOCKER_IMAGE);
  const configured = configuredImage ? inspectDockerImage(dockerCommand, configuredImage) : null;
  const firstRunWillPrepare = !configuredImage && !cacheDisabled && !prepared.exists;
  const repeatedPrepareLikely = !configuredImage && cacheDisabled && !prepared.exists;
  const configuredMissing = Boolean(configured && !configured.exists);
  let state = "ready";
  let message = `Prepared Docker image ${PREPARED_KLEE_DOCKER_IMAGE} is present. Windows C coverage should skip LLVM/lcov bootstrap.`;
  if (configuredImage) {
    state = configuredMissing ? "configured_image_missing" : "configured_image_selected";
    message = configuredMissing
      ? `PERFECTONE_KLEE_IMAGE is set to ${configuredImage}, but that Docker image was not found.`
      : `PERFECTONE_KLEE_IMAGE is set to ${configuredImage}; PerfectOne will use that image instead of the prepared cache image.`;
  } else if (firstRunWillPrepare) {
    state = "first_run_prepare_required";
    message = `Prepared Docker image ${PREPARED_KLEE_DOCKER_IMAGE} is not present. The first Windows C coverage run will create it; expected time is ${DOCKER_PREP_ESTIMATE}. Later runs reuse the image.`;
  } else if (repeatedPrepareLikely) {
    state = "cache_disabled_prepare_each_run";
    message = `Prepared Docker image ${PREPARED_KLEE_DOCKER_IMAGE} is not present and PERFECTONE_DISABLE_DOCKER_IMAGE_CACHE is enabled. Docker coverage may prepare LLVM/lcov tools on each run; expected time is ${DOCKER_PREP_ESTIMATE}.`;
  }
  return {
    ...status,
    checked: true,
    preparedImagePresent: prepared.exists,
    baseImagePresent: base.exists,
    configuredImagePresent: configured ? configured.exists : null,
    firstRunWillPrepare,
    repeatedPrepareLikely,
    status: state,
    message,
    inspect: { prepared, base, configured }
  };
}

function stalePluginCaches(home) {
  const cacheRoot = path.join(home, "plugins", "cache");
  return [
    path.join(cacheRoot, "perfectone-local-marketplace", "perfectone-unit-verify"),
    path.join(cacheRoot, "perfectone-local", "perfectone-unit-verify")
  ].filter((candidate) => existsSync(candidate));
}

function cliCandidates(root, hostOs, explicit) {
  if (explicit) return [explicit];
  if (process.env.PERFECTONE_CLI) return [process.env.PERFECTONE_CLI];
  const source = path.join(root, "bin");
  const byOs = {
    windows: [path.join(source, "windows", "ClangParserForWin.exe")],
    linux: [path.join(source, "linux", "ClangParserForLinux")],
    macos: [path.join(source, "macos", "ClangParserForMac")]
  };
  return byOs[hostOs] || [];
}

function request(server, method, params = {}) {
  const id = request.nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120000);
    request.pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}
request.nextId = 1;
request.pending = new Map();

async function startServer(serverPath, cwd) {
  const server = spawn(process.execPath, [serverPath], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const stderr = [];
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id && request.pending.has(message.id)) {
        request.pending.get(message.id)(message);
        request.pending.delete(message.id);
      }
    }
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => stderr.push(chunk));
  return { server, stderr };
}

const workspaceRoot = path.resolve(argValue("--workspaceRoot", argValue("-WorkspaceRoot", process.env.PERFECTONE_WORKSPACE_ROOT || defaultWorkspaceRoot)));
const codexHome = path.resolve(argValue("--codexHome", argValue("-CodexHome", path.join(os.homedir(), ".codex"))));
const hostOs = normalizeHostOs(argValue("--hostOs", process.platform));
const runner = String(argValue("--runner", "auto")).toLowerCase();
const explicitCli = argValue("--perfectoneCli", argValue("-PerfectOneCli", null));
const failOnDuplicate = hasFlag("--failOnDuplicateRegistration") || hasFlag("-FailOnDuplicateRegistration");
const serverPath = path.join(pluginRoot, "mcp-server", "src", "server.js");
const cliPath = cliCandidates(workspaceRoot, hostOs, explicitCli).find((candidate) => existsSync(candidate)) || null;
const errors = [];
const warnings = [];

for (const requiredPath of [serverPath, path.join(pluginRoot, ".codex-plugin", "plugin.json")]) {
  if (!existsSync(requiredPath)) errors.push(`missing required file: ${requiredPath}`);
}
if (!cliPath) warnings.push("PerfectOne CLI was not found. Set PERFECTONE_CLI or place the externally provisioned CLI under bin/<platform> before C verification.");

const configPath = path.join(codexHome, "config.toml");
if (existsSync(configPath)) {
  const text = readFileSync(configPath, "utf8");
  if (/\[plugins\."perfectone-unit-verify@perfectone-local-marketplace"\]/.test(text)) warnings.push("legacy plugin alias remains enabled: perfectone-unit-verify@perfectone-local-marketplace");
  const mcpMatches = text.match(/^\[mcp_servers\.perfectone-unit-verify\]/gm) || [];
  if (mcpMatches.length > 1) warnings.push(`duplicate mcp_servers.perfectone-unit-verify sections: ${mcpMatches.length}`);
  if (/\[plugins\."perfectone-unit-verify@perfectone-local"\]/.test(text) && /\[plugins\."perfectone-unit-verify@perfectone-local-marketplace"\]/.test(text)) {
    warnings.push("multiple PerfectOne plugin marketplace registrations are enabled");
  }
}
const staleCaches = stalePluginCaches(codexHome);
for (const cachePath of staleCaches) warnings.push(`stale PerfectOne unit verify plugin cache remains: ${cachePath}`);
if (failOnDuplicate && warnings.some((item) => /duplicate|legacy|multiple|stale/.test(item))) {
  errors.push("duplicate registration warning promoted to failure");
}

const probeTools = ["gcc", "clang", "gcov", "llvm-cov", "llvm-profdata", "cmake", "ninja", "docker", "klee", "pkg-config"];
const probes = Object.fromEntries(probeTools.map((tool) => [tool, findTool(tool)]));
const dockerPreparation = dockerPreparationStatus(hostOs, probes.docker, runner !== "noop");
if (dockerPreparation.status === "configured_image_missing") {
  errors.push(dockerPreparation.message);
} else if (dockerPreparation.firstRunWillPrepare || dockerPreparation.repeatedPrepareLikely) {
  warnings.push(dockerPreparation.message);
}
if (hostOs === "windows" && runner === "wsl") {
  warnings.push("WSL runner is disabled for this plugin path. Use Docker for the PerfectOne KLEE baseline and Windows local LLVM/lld-link for residual coverage.");
}

let toolNames = [];
let envProbe = null;
if (errors.length === 0) {
  const tmp = path.join(os.tmpdir(), `perfectone-doctor-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const { server, stderr } = await startServer(serverPath, tmp);
  try {
    const init = await request(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "doctor", version: "1" } });
    if (init.error) errors.push(`initialize failed: ${JSON.stringify(init.error)}`);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await request(server, "tools/list", {});
    toolNames = (list.result?.tools || []).map((item) => item.name);
    const requiredTools = [
      "unitverify_extract_design_from_source",
      "unitverify_validate_artifact",
      "unitverify_render_review_html",
      "unitverify_import_manual_tests",
      "unitverify_export_manual_tests",
      "unitverify_compare_expected_values",
      "unitverify_build_traceability_report",
      "unitverify_detect_toolchain_environment",
      "unitverify_prepare_windows_local_mcdc",
      "perfectone_prepare_cli",
      "perfectone_capabilities",
      "perfectone_detect_c_project",
      "perfectone_run_unit_verification",
      "perfectone_run_c_unit_verify_full",
      "perfectone_run_filtered_c_coverage",
      "perfectone_get_coverage_job_status",
      "perfectone_collect_coverage_job_result",
      "perfectone_cancel_coverage_job",
      "perfectone_get_artifact_manifest",
      "perfectone_replay"
    ];
    for (const tool of requiredTools) if (!toolNames.includes(tool)) errors.push(`missing MCP tool: ${tool}`);
    const envRes = await request(server, "tools/call", {
      name: "unitverify_detect_toolchain_environment",
      arguments: { projectRoot: workspaceRoot, language: "c", sourceFiles: [], environment: { hostOs } }
    });
    envProbe = envRes.result?.structuredContent || null;
  } finally {
    try { server.kill(); } catch {}
    if (stderr.join("").trim()) warnings.push(`MCP stderr observed: ${stderr.join("").slice(0, 1000)}`);
  }
}

const output = { status: errors.length ? "failed" : "passed", workspaceRoot, pluginRoot, hostOs, cliPath, tools: toolNames, probes, dockerPreparation, stalePluginCaches: staleCaches, envProbe, warnings, errors };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
process.exit(errors.length ? 1 : 0);
