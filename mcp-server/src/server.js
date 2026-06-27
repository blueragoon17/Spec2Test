#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createWriteStream, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginRoot = path.resolve(__dirname, "..", "..");
const defaultWorkspaceRoot = path.resolve(pluginRoot, "..", "..");
const workspaceRoot = path.resolve(pluginRoot, process.env.PERFECTONE_WORKSPACE_ROOT || defaultWorkspaceRoot);
const schemasRoot = path.join(pluginRoot, "schemas");
const MAX_OUTPUT = 1024 * 1024;
const MAX_EXCERPT = 6000;
const PREPARED_KLEE_DOCKER_IMAGE = "perfectone/klee-coverage-tools:llvm18-lcov-v1";
const BASE_KLEE_DOCKER_IMAGE = "klee/klee:v3.2";
const DOCKER_PREP_ESTIMATE = "usually 10-20 minutes, up to about 30 minutes depending on network and Docker cache state";
const DEFAULT_WSL_DISTRO = "Ubuntu-24.04";
const WINDOWS_LLVM_MIN_MAJOR = 21;
const WINDOWS_LLVM_WINGET_ID = "LLVM.LLVM";
const DOCKER_LLVM18_COVERAGE_TOOLS = {
  clang: "/usr/bin/clang-18",
  llvmCov: "/usr/bin/llvm-cov-18",
  llvmProfdata: "/usr/bin/llvm-profdata-18"
};
const C_COVERAGE_PROFILE_DEFAULTS = {
  quick: {
    kleeMaxTime: 60,
    kleeMaxMemory: 4096,
    replayMaxCasesPerFunction: 128,
    replayDedup: "input-hash",
    nativeReplayTimeout: 5
  },
  full: {
    kleeMaxTime: 60,
    kleeMaxMemory: 8192,
    replayMaxCasesPerFunction: 0,
    replayDedup: "none",
    nativeReplayTimeout: 30
  },
  setup: {
    kleeMaxTime: 60,
    kleeMaxMemory: 4096,
    replayMaxCasesPerFunction: 128,
    replayDedup: "input-hash",
    nativeReplayTimeout: 5
  }
};
const COVERAGE_JOB_POLL_MS = 30000;
const coverageJobs = new Map();

function normalizeProcessTimeoutMs(value, fallbackMs) {
  const raw = value ?? fallbackMs;
  if (raw === null) return null;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function normalizeCoverageProcessTimeoutMs(value) {
  const timeoutMs = normalizeProcessTimeoutMs(value, 1800000);
  if (timeoutMs === null) return 1800000;
  return Math.max(timeoutMs, 1800000);
}

const UNIT_DESIGN_SCHEMA_FILES = {
  "unitverify.spec-analysis.v1": "unitverify.spec-analysis.v1.schema.json",
  "unitverify.test-design.v1": "unitverify.test-design.v1.schema.json",
  "unitverify.assertion.v1": "unitverify.assertion.v1.schema.json",
  "unitverify.oracle.v1": "unitverify.oracle.v1.schema.json",
  "unitverify.traceability.v1": "unitverify.traceability.v1.schema.json",
  "unitverify.review.v1": "unitverify.review.v1.schema.json"
};

const REVIEW_STATUSES = new Set(["specified", "inferred", "missing", "needs_review", "approved", "rejected"]);

const SKIP_DIRS = new Set([
  ".git",
  ".perfectone",
  ".vs",
  ".vscode",
  "_deps",
  "cmake_build",
  "cmakefiles",
  "llvm",
  "node_modules",
  "debug",
  "release",
  "x64",
  "win32"
]);

const TOOL_VERSION_ARGS = {
  gcc: ["--version"],
  "g++": ["--version"],
  clang: ["--version"],
  "clang++": ["--version"],
  gcov: ["--version"],
  "llvm-cov": ["--version"],
  "llvm-profdata": ["--version"],
  "lld-link": ["--version"],
  cmake: ["--version"],
  ninja: ["--version"],
  docker: ["--version"],
  klee: ["--version"],
  "pkg-config": ["--version"],
  xcrun: ["--version"],
  python: ["--version"],
  python3: ["--version"],
  pytest: ["--version"],
  coverage: ["--version"],
  node: ["--version"],
  npm: ["--version"],
  go: ["version"],
  java: ["-version"],
  javac: ["-version"],
  mvn: ["--version"],
  gradle: ["--version"],
  dotnet: ["--version"],
  cargo: ["--version"],
  rustc: ["--version"],
  ruby: ["--version"],
  bundle: ["--version"]
};

const HOST_OS_ALIASES = new Map([
  ["win32", "windows"],
  ["windows", "windows"],
  ["linux", "linux"],
  ["darwin", "macos"],
  ["mac", "macos"],
  ["macos", "macos"]
]);

const EMBEDDED_TARGETS = new Set(["embedded", "baremetal", "rtos"]);

function envFlagEnabled(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ""));
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolContentForResult(result) {
  const action = result?.codingAgentResidualActionRequired || result?.actionRequired || null;
  const actionText = action?.message || result?.codingAgentResidualRepairPrompt || result?.codingPlatformPrompt || "";
  if (action?.completionBlocked || result?.status === "needs_coding_agent_residual" || result?.status === "needs_coding_agent_augmentation") {
    return [
      {
        type: "text",
        text: [
          "ACTION REQUIRED: verification is not complete.",
          actionText,
          "Do not produce a final verification answer yet. Continue by adding coding-agent test cases, editing generated harnesses/fixtures/testcase inputs when needed, recompiling/replaying, and remeasuring coverage."
        ].filter(Boolean).join("\n")
      },
      { type: "text", text: JSON.stringify(result, null, 2) }
    ];
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) }];
}

function toolResult(id, result, isError = false) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: toolContentForResult(result),
      structuredContent: result,
      isError
    }
  });
}

function protocolError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function perfectOneCliCandidates(explicitPath, options = {}) {
  const hostOs = normalizeHostOs(options.hostOs);
  const baseWorkspaceRoot = path.resolve(options.workspaceRoot || workspaceRoot);
  const candidates = [];
  if (explicitPath) return [explicitPath];
  if (process.env.PERFECTONE_CLI) return [process.env.PERFECTONE_CLI];
  const byOs = {
    windows: [path.join(baseWorkspaceRoot, "bin", "windows", "ClangParserForWin.exe")],
    linux: [path.join(baseWorkspaceRoot, "bin", "linux", "ClangParserForLinux")],
    macos: [path.join(baseWorkspaceRoot, "bin", "macos", "ClangParserForMac")]
  };
  for (const candidate of byOs[hostOs] || []) candidates.push(candidate);
  return candidates;
}

function findPerfectOneCli(explicitPath, options = {}) {
  const candidates = perfectOneCliCandidates(explicitPath, options);
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function perfectOneSourceRoots(baseWorkspaceRoot = workspaceRoot) {
  const roots = [];
  const add = (candidate) => {
    if (!candidate) return;
    const resolved = path.resolve(candidate);
    if (!roots.includes(resolved)) roots.push(resolved);
  };
  add(baseWorkspaceRoot);
  return roots;
}

function toWslPath(value) {
  if (!value) return value;
  const normalized = String(value).replace(/\\/g, "/");
  if (normalized.startsWith("/")) return normalized;
  const resolved = path.resolve(value).replace(/\\/g, "/");
  const match = resolved.match(/^([A-Za-z]):\/(.*)$/);
  if (!match) return resolved;
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

function perfectOneWslCliCandidates(explicitPath, options = {}) {
  const baseWorkspaceRoot = path.resolve(options.workspaceRoot || workspaceRoot);
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const raw = String(candidate);
    const windowsPath = /^[A-Za-z]:[\\/]/.test(raw) || raw.includes("\\")
      ? path.resolve(raw)
      : (raw.startsWith("/") ? null : path.resolve(baseWorkspaceRoot, raw));
    const linuxPath = raw.startsWith("/") ? raw : toWslPath(windowsPath || raw);
    if (!linuxPath || seen.has(linuxPath)) return;
    seen.add(linuxPath);
    candidates.push({ windowsPath, linuxPath });
  };
  add(explicitPath);
  add(process.env.PERFECTONE_WSL_CLI);
  for (const sourceRoot of perfectOneSourceRoots(baseWorkspaceRoot)) {
    add(path.join(sourceRoot, "ClangParserForLinux", "build", "bin", "ClangParserForLinux"));
  }
  return candidates;
}

function probeWslPerfectOneCli(environment = {}, options = {}) {
  const env = normalizeEnvironment(environment);
  if (!shouldProbeWsl(env)) return null;
  const wsl = wslCommand();
  if (!wsl) return null;
  for (const candidate of perfectOneWslCliCandidates(options.explicitPath, options)) {
    const script = [
      `cli='${candidate.linuxPath.replace(/'/g, "'\\''")}'`,
      "test -x \"$cli\" || exit 127",
      "printf '%s\\n' \"$cli\"",
      "\"$cli\" --capabilities --json 2>/dev/null | head -c 2000 || true"
    ].join("\n");
    const completed = spawnSync(wsl, ["-d", env.wslDistro, "--exec", "bash", "-lc", script], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true
    });
    if (completed.status !== 0) continue;
    const lines = `${completed.stdout || ""}`.split(/\r?\n/).filter(Boolean);
    const linuxPath = (lines[0] || "").trim();
    if (!linuxPath.startsWith("/") || linuxPath.includes("\u0000")) continue;
    let capabilities = null;
    const jsonText = lines.slice(1).join("\n").trim();
    if (jsonText) {
      try {
        capabilities = JSON.parse(jsonText);
      } catch {
        capabilities = null;
      }
    }
    return {
      available: true,
      command: `wsl.exe -d ${env.wslDistro} --exec ${linuxPath}`,
      linuxPath,
      windowsPath: candidate.windowsPath,
      distro: env.wslDistro,
      capabilities
    };
  }
  return {
    available: false,
    distro: env.wslDistro,
    candidates: perfectOneWslCliCandidates(options.explicitPath, options)
  };
}

function runCli(cliPath, args, options = {}) {
  const timeoutMs = normalizeProcessTimeoutMs(options.timeoutMs, 1800000);
  const startedAt = new Date();
  const startedMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn(cliPath, args, {
      cwd: options.cwd || workspaceRoot,
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const completedAt = new Date();
      resolve({ code, stdout, stderr, timedOut, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), elapsedMs: Date.now() - startedMs });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      const completedAt = new Date();
      resolve({ code: 127, stdout, stderr: String(error), timedOut, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), elapsedMs: Date.now() - startedMs });
    });
  });
}

function parseJsonOutput(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      parseError: "CLI stdout was not valid JSON"
    };
  }
}

async function readTextIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    const text = await readFile(filePath, "utf8");
    return text.slice(0, MAX_OUTPUT);
  } catch {
    return "";
  }
}

async function readFullTextIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function truncate(text, max = MAX_EXCERPT) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...truncated...`;
}

function redactSensitiveValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item));
  if (!value || typeof value !== "object") return value;
  const redacted = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(^|[_-])(access|refresh|id)?token($|[_-])|secret|password|authorization|cookie|api[_-]?key|private[_-]?key|bearer/i.test(key)) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactSensitiveValue(item);
    }
  }
  return redacted;
}

function payloadText(value, options = {}) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(options.redact === false ? value : redactSensitiveValue(value));
  } catch {
    return String(value);
  }
}

function estimateTokenCount(text) {
  const value = String(text || "");
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

function tokenUsageItem(direction, name, value, options = {}) {
  const text = payloadText(value, options);
  return {
    direction,
    surface: options.surface || "plugin",
    name,
    chars: text.length,
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokenCount(text),
    redacted: options.redact !== false
  };
}

function summarizeTokenUsage(items, direction) {
  const filtered = items.filter((item) => item.direction === direction);
  return {
    chars: filtered.reduce((sum, item) => sum + item.chars, 0),
    bytes: filtered.reduce((sum, item) => sum + item.bytes, 0),
    estimatedTokens: filtered.reduce((sum, item) => sum + item.estimatedTokens, 0)
  };
}

function summarizeTokenUsageBySurface(items) {
  const bySurface = {};
  for (const item of items) {
    const key = item.surface || "plugin";
    if (!bySurface[key]) bySurface[key] = { chars: 0, bytes: 0, estimatedTokens: 0 };
    bySurface[key].chars += item.chars;
    bySurface[key].bytes += item.bytes;
    bySurface[key].estimatedTokens += item.estimatedTokens;
  }
  return bySurface;
}

function buildTokenUsage({ inputPayloads = [], outputPayloads = [], oauth = null, observedSurfaces = [] }) {
  const items = [];
  for (const item of inputPayloads) {
    items.push(tokenUsageItem("input", item.name, item.value, item));
  }
  for (const item of outputPayloads) {
    items.push(tokenUsageItem("output", item.name, item.value, item));
  }
  if (oauth) {
    items.push(tokenUsageItem("input", "oauthConfiguration", oauth, { surface: "oauth", redact: true }));
  }
  const input = summarizeTokenUsage(items, "input");
  const output = summarizeTokenUsage(items, "output");
  return {
    schemaVersion: "unitverify.plugin-token-usage.v1",
    scope: "plugin-bundle-observable-io",
    approximation: true,
    tokenizer: "estimated_chars_div_4",
    note: "Estimated from plugin-observable I/O: skill context, plugin metadata, MCP tool payloads, CLI/log/report payloads, and redacted OAuth metadata when present. This is not provider billing telemetry.",
    oauth: oauth || { configured: false, observedRuntimeTokens: false, secretValuesRecorded: false },
    observedSurfaces: Array.from(new Set([...observedSurfaces, ...items.map((item) => item.surface)])),
    unobservedSurfaces: ["host coding-agent LLM provider billing tokens", "OAuth access/refresh token values"],
    input,
    output,
    total: {
      chars: input.chars + output.chars,
      bytes: input.bytes + output.bytes,
      estimatedTokens: input.estimatedTokens + output.estimatedTokens
    },
    bySurface: summarizeTokenUsageBySurface(items),
    items
  };
}

function readJsonFileSync(filePath) {
  const parsed = readJsonSync(filePath);
  return parsed || null;
}

function pluginStaticInputPayloads() {
  const payloads = [];
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const mcpConfigPath = path.join(pluginRoot, ".mcp.json");
  const manifest = readJsonFileSync(manifestPath);
  const mcpConfig = readJsonFileSync(mcpConfigPath);
  if (manifest) payloads.push({ name: "pluginManifest", value: manifest, surface: "plugin-metadata" });
  if (mcpConfig) payloads.push({ name: "mcpServerConfig", value: mcpConfig, surface: "mcp" });
  const skillsDir = path.join(pluginRoot, "skills");
  let skillEntries = [];
  try {
    skillEntries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    skillEntries = [];
  }
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (pathExists(skillPath)) {
      payloads.push({ name: `skill:${entry.name}`, value: readSmallTextSync(skillPath, MAX_OUTPUT), surface: "skill" });
    }
  }
  return payloads;
}

function detectOauthMetadata() {
  const metadata = {
    configured: false,
    observedRuntimeTokens: false,
    secretValuesRecorded: false,
    redactionPolicy: "OAuth client secrets, access tokens, refresh tokens, id tokens, authorization headers, cookies, and API keys are never stored in token usage artifacts.",
    files: []
  };
  for (const filePath of [
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    path.join(pluginRoot, ".mcp.json")
  ]) {
    const text = readSmallTextSync(filePath, MAX_OUTPUT);
    if (/oauth|authorization|client_id|clientId|scopes?/i.test(text)) {
      metadata.configured = true;
      metadata.files.push(relativeArtifact(filePath, pluginRoot));
    }
  }
  return metadata;
}

function buildPluginTokenUsage({ inputPayloads = [], outputPayloads = [] }) {
  return buildTokenUsage({
    inputPayloads: [...pluginStaticInputPayloads(), ...inputPayloads],
    outputPayloads,
    oauth: detectOauthMetadata(),
    observedSurfaces: ["plugin-metadata", "skill", "mcp", "cli", "report", "oauth"]
  });
}

function pathExists(filePath) {
  return Boolean(filePath) && existsSync(filePath);
}

function pushUnique(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

function isSkippedDir(name) {
  const lower = name.toLowerCase();
  return SKIP_DIRS.has(lower) || lower.startsWith("build") || lower.startsWith(".");
}

function normalizeHostOs(value = "auto") {
  if (!value || value === "auto") return HOST_OS_ALIASES.get(process.platform) || process.platform;
  return HOST_OS_ALIASES.get(String(value).toLowerCase()) || String(value).toLowerCase();
}

function normalizeTargetOs(value = "auto", hostOs = normalizeHostOs()) {
  if (!value || value === "auto") return hostOs;
  return String(value).toLowerCase();
}

function normalizeEnvironment(environment = {}) {
  const hostOs = normalizeHostOs(environment.hostOs ?? environment.hostOS);
  const targetOs = normalizeTargetOs(environment.targetOs ?? environment.targetOS, hostOs);
  const { hostOS, targetOS, ...rest } = environment;
  return {
    ...rest,
    hostOs,
    targetOs,
    wslDistro: environment.wslDistro || DEFAULT_WSL_DISTRO,
    isEmbeddedTarget: EMBEDDED_TARGETS.has(targetOs)
  };
}

function sanitizeJsonValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, seen));
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if ((key === "hostOS" || key === "targetOS") && (Object.prototype.hasOwnProperty.call(value, "hostOs") || Object.prototype.hasOwnProperty.call(value, "targetOs"))) {
      continue;
    }
    out[key] = sanitizeJsonValue(raw, seen);
  }
  return out;
}

function runWslCli(wslCli, args, options = {}) {
  const timeoutMs = normalizeProcessTimeoutMs(options.timeoutMs, 1800000);
  const distro = options.wslDistro || wslCli?.distro || DEFAULT_WSL_DISTRO;
  const startedAt = new Date();
  const startedMs = Date.now();
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-d", distro, "--exec", wslCli.linuxPath, ...args], {
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) }
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const completedAt = new Date();
      resolve({ code, stdout, stderr, timedOut, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), elapsedMs: Date.now() - startedMs });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      const completedAt = new Date();
      resolve({ code: 127, stdout, stderr: String(error), timedOut, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), elapsedMs: Date.now() - startedMs });
    });
  });
}

async function probePerfectOneCliCapabilities(cliPath, options = {}) {
  if (!cliPath) {
    return { cliPath: null, available: false, cCoverageSupported: false, phases: [], cCoverageRunners: [], error: "cli_not_found" };
  }
  const result = await runCli(cliPath, ["--capabilities", "--json"], {
    cwd: options.cwd || path.dirname(cliPath),
    timeoutMs: options.timeoutMs ?? 15000
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    parsed = null;
  }
  const phases = Array.isArray(parsed?.phases) ? parsed.phases : [];
  const cCoverageRunners = Array.isArray(parsed?.cCoverageRunners) ? parsed.cCoverageRunners : [];
  const cCoverageSupported = phases.includes("c-coverage") || cCoverageRunners.length > 0;
  return {
    cliPath,
    available: result.code === 0 && Boolean(parsed),
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    cCoverageSupported,
    phases,
    cCoverageRunners,
    stdout: truncate(result.stdout, 2000),
    stderr: truncate(result.stderr, 2000)
  };
}

function processHostOs() {
  return normalizeHostOs(process.platform);
}

function shouldProbeHost(hostOs) {
  return normalizeHostOs(hostOs) === processHostOs();
}

function shouldProbeWsl(environment = {}) {
  const env = normalizeEnvironment(environment);
  return processHostOs() === "windows" && env.hostOs === "windows";
}

function wslCommand() {
  if (process.platform !== "win32") return null;
  const found = spawnSync("where.exe", ["wsl.exe"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (found.status === 0) {
    const first = `${found.stdout || ""}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first) return first;
  }
  return "wsl.exe";
}

function probeWslTool(name, environment = {}) {
  const env = normalizeEnvironment(environment);
  if (!shouldProbeWsl(env)) return null;
  const wsl = wslCommand();
  if (!wsl) return null;
  const aliases = {
    clang: ["clang-18", "clang"],
    "clang++": ["clang++-18", "clang++"],
    "llvm-cov": ["llvm-cov-18", "llvm-cov"],
    "llvm-profdata": ["llvm-profdata-18", "llvm-profdata"]
  };
  const candidates = aliases[name] || [name];
  const script = [
    "set -e",
    `for t in ${candidates.map((item) => `'${item.replace(/'/g, "'\\''")}'`).join(" ")}; do`,
    "  if command -v \"$t\" >/dev/null 2>&1; then",
    "    p=$(command -v \"$t\")",
    name === "klee" ? "    test -f /usr/local/lib/klee/runtime/klee-uclibc.bca || exit 127" : "",
    "    v=$($t --version 2>&1 | head -n 1 || true)",
    "    printf '%s\\n%s\\n' \"$p\" \"$v\"",
    "    exit 0",
    "  fi",
    "done",
    "exit 127"
  ].join("\n");
  const completed = spawnSync(wsl, ["-d", env.wslDistro, "--exec", "bash", "-lc", script], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  const lines = `${completed.stdout || ""}`.split(/\r?\n/).filter(Boolean);
  const linuxCommand = (lines[0] || "").trim();
  const combinedOutput = `${completed.stdout || ""}\n${completed.stderr || ""}`;
  if (
    !linuxCommand ||
    !linuxCommand.startsWith("/") ||
    linuxCommand.includes("\u0000") ||
    /WSL_E_DISTRO_NOT_FOUND|distribution.*not.*found|distro.*not.*found/i.test(combinedOutput)
  ) {
    return null;
  }
  return {
    command: `wsl.exe -d ${env.wslDistro} --exec ${linuxCommand}`,
    linuxCommand,
    version: lines[1] || null,
    distro: env.wslDistro
  };
}

function fallbackToolPaths(name, hostOs = processHostOs()) {
  if (hostOs !== "windows") return [];
  const fallbacks = {
    gcc: [String.raw`C:\Strawberry\c\bin\gcc.exe`, String.raw`C:\msys64\mingw64\bin\gcc.exe`],
    "g++": [String.raw`C:\Strawberry\c\bin\g++.exe`, String.raw`C:\msys64\mingw64\bin\g++.exe`],
    gcov: [String.raw`C:\Strawberry\c\bin\gcov.exe`, String.raw`C:\msys64\mingw64\bin\gcov.exe`],
    clang: [String.raw`C:\Program Files\LLVM\bin\clang.exe`],
    "clang++": [String.raw`C:\Program Files\LLVM\bin\clang++.exe`],
    "llvm-cov": [String.raw`C:\Program Files\LLVM\bin\llvm-cov.exe`],
    "llvm-profdata": [String.raw`C:\Program Files\LLVM\bin\llvm-profdata.exe`],
    "lld-link": [String.raw`C:\Program Files\LLVM\bin\lld-link.exe`],
    cmake: [String.raw`C:\Program Files\CMake\bin\cmake.exe`],
    ninja: [String.raw`C:\Program Files\Ninja\ninja.exe`],
    docker: [String.raw`C:\Program Files\Docker\Docker\resources\bin\docker.exe`]
  };
  return fallbacks[name] || [];
}

function resolveTool(name, options = {}) {
  const hostOs = normalizeHostOs(options.hostOs);
  if (options.explicitPath && existsSync(options.explicitPath)) return options.explicitPath;
  if (shouldProbeHost(hostOs)) {
    const where = process.platform === "win32" ? "where.exe" : "which";
    const found = spawnSync(where, [name], { encoding: "utf8", timeout: 5000 });
    const output = `${found.stdout || ""}\n${found.stderr || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found.status === 0 && output) return output;
  }
  return fallbackToolPaths(name, hostOs).find((candidate) => existsSync(candidate)) || null;
}

function installHintForTool(name, context = {}) {
  const hostOs = normalizeHostOs(context.hostOs);
  const language = String(context.language || "").toLowerCase();
  const windowsC = hostOs === "windows" && language === "c";
  if (name === "docker") {
    return hostOs === "windows"
      ? "Install Docker Desktop. Windows C coverage defaults to Docker for PerfectOne KLEE execution."
      : "Install Docker Engine or Docker Desktop only when the Docker runner is explicitly selected.";
  }
  if (["clang", "clang++", "llvm-cov", "llvm-profdata"].includes(name)) {
    if (hostOs === "windows") return "Install LLVM for Windows for local residual native replay and coverage aggregation.";
    if (hostOs === "macos") return "Install Xcode Command Line Tools and Homebrew LLVM when the system clang lacks the required coverage flags.";
    return "Install clang/LLVM packages for this Linux distribution, including llvm-cov and llvm-profdata.";
  }
  if (["gcc", "g++", "gcov"].includes(name)) {
    if (windowsC) return "Install a Windows C compiler only for local residual harness builds; Docker remains the KLEE baseline.";
    if (hostOs === "windows") return "Install MSYS2/MinGW or Strawberry Perl toolchain, then expose gcc/g++/gcov on PATH.";
    if (hostOs === "macos") return "Install Xcode Command Line Tools or Homebrew GCC if GCC/gcov coverage is needed.";
    return "Install GCC and gcov packages for this Linux distribution.";
  }
  if (name === "klee") return hostOs === "windows" ? "Use the Docker PerfectOne KLEE image; WSL KLEE is disabled for this plugin." : "Install KLEE natively, or explicitly select Docker if desired.";
  if (name === "cmake") return windowsC ? "Install CMake for Windows only when local residual builds require it." : (hostOs === "windows" ? "Install CMake for Windows." : "Install CMake through the OS package manager.");
  if (name === "ninja") return windowsC ? "Install Ninja for Windows only when local residual builds require it." : (hostOs === "windows" ? "Install Ninja for Windows." : "Install Ninja through the OS package manager.");
  if (name === "pkg-config") return windowsC ? "Install pkg-config only when local residual builds require it." : "Install pkg-config so library compile/link flags can be discovered.";
  if (["python", "python3", "pytest", "coverage"].includes(name)) return "Install Python, pytest, and coverage.py in the target test environment.";
  if (["node", "npm"].includes(name)) return "Install Node.js and npm, then install the project test/coverage dependencies.";
  if (name === "go") return "Install Go and ensure go test can run for the target module.";
  if (["java", "javac", "mvn", "gradle"].includes(name)) return "Install a JDK and the project Maven or Gradle runner.";
  if (name === "dotnet") return "Install the .NET SDK and project coverage tooling such as coverlet when needed.";
  if (["cargo", "rustc"].includes(name)) return "Install Rust through rustup and add cargo-llvm-cov when LLVM coverage is required.";
  if (["ruby", "bundle"].includes(name)) return "Install Ruby, Bundler, and the project test/coverage gems.";
  if (language === "cpp") return "Install the native compiler, build system, and test/coverage libraries required by the C++ target.";
  return `Install ${name} for ${hostOs}.`;
}

function toolCapability(name, context = {}) {
  const env = normalizeEnvironment(context);
  const command = resolveTool(name, context);
  let version = null;
  if (command) {
    const args = TOOL_VERSION_ARGS[name] || ["--version"];
    const completed = spawnSync(command, args, { encoding: "utf8", timeout: 10000 });
    version = `${completed.stdout || completed.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
  }
  return {
    name,
    available: Boolean(command),
    command,
    runner: "host",
    wslDistro: null,
    linuxCommand: null,
    version,
    installHint: command ? null : installHintForTool(name, context)
  };
}

function hostToolCapability(name, context = {}) {
  const env = normalizeEnvironment(context);
  const hostOs = normalizeHostOs(context.hostOs || env.hostOs || processHostOs());
  const command = resolveTool(name, { ...context, hostOs, explicitPath: context.explicitPath });
  let version = null;
  if (command) {
    const args = TOOL_VERSION_ARGS[name] || ["--version"];
    const completed = spawnSync(command, args, { encoding: "utf8", timeout: 10000, windowsHide: true });
    version = `${completed.stdout || completed.stderr || ""}`.trim().split(/\r?\n/)[0] || null;
  }
  return {
    name,
    available: Boolean(command),
    command,
    runner: "host",
    hostOs,
    version,
    installHint: command ? null : installHintForTool(name, { ...context, hostOs })
  };
}

function llvmMajorVersion(version) {
  const match = String(version || "").match(/\b(?:version|LLD)\s+(\d+)(?:\.|$)/i) || String(version || "").match(/\b(\d+)\.\d+\.\d+\b/);
  return match ? Number(match[1]) : null;
}

function clangSupportsMcdcCommand(command) {
  if (!command) return false;
  const completed = spawnSync(command, ["--help"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  return /-fcoverage-mcdc\b/.test(`${completed.stdout || ""}\n${completed.stderr || ""}`);
}

function windowsLlvmInstallPlan() {
  return {
    requiresUserApproval: true,
    package: "LLVM for Windows",
    minimumMajorVersion: WINDOWS_LLVM_MIN_MAJOR,
    preferredCommand: `winget install --id ${WINDOWS_LLVM_WINGET_ID} -e --source winget --accept-package-agreements --accept-source-agreements`,
    fallbackCommands: [
      "choco install llvm -y",
      "Download and install LLVM for Windows from https://github.com/llvm/llvm-project/releases"
    ],
    postInstallExpectation: "clang.exe, lld-link.exe, llvm-cov.exe, and llvm-profdata.exe are available on PATH or under C:\\Program Files\\LLVM\\bin."
  };
}

function detectWindowsLocalMcdcToolchain(environment = {}) {
  const env = normalizeEnvironment(environment);
  if (env.hostOs !== "windows") {
    return {
      available: false,
      applicable: false,
      reason: "not_windows_host"
    };
  }
  const tools = {
    clang: hostToolCapability("clang", { ...env, language: "c" }),
    lldLink: hostToolCapability("lld-link", { ...env, language: "c" }),
    llvmCov: hostToolCapability("llvm-cov", { ...env, language: "c" }),
    llvmProfdata: hostToolCapability("llvm-profdata", { ...env, language: "c" })
  };
  const missingTools = Object.entries(tools)
    .filter(([, tool]) => !tool.available)
    .map(([name]) => name);
  const clangMajor = llvmMajorVersion(tools.clang.version);
  const lldMajor = llvmMajorVersion(tools.lldLink.version);
  const versionMatched = Boolean(clangMajor && lldMajor && clangMajor === lldMajor);
  const minimumVersionMet = Boolean(clangMajor && clangMajor >= WINDOWS_LLVM_MIN_MAJOR);
  const mcdcFlagSupported = clangSupportsMcdcCommand(tools.clang.command);
  const available = missingTools.length === 0 && versionMatched && minimumVersionMet && mcdcFlagSupported;
  return {
    schemaVersion: "perfectone.windows-local-mcdc.toolchain.v1",
    applicable: true,
    available,
    strategy: "windows-local-llvm-lld-link-residual-mcdc",
    priority: available ? "first_for_coding_agent_residual" : "install_prompt_required",
    tools,
    clangMajor,
    lldMajor,
    versionMatched,
    minimumVersionMet,
    mcdcFlagSupported,
    missingTools,
    compileTemplate: "clang.exe -O0 -g -fprofile-instr-generate -fcoverage-mapping -fcoverage-mcdc -fuse-ld=lld -Wl,/INCREMENTAL:NO <generated_harness.c> -o <generated_harness.exe>",
    runTemplate: "set LLVM_PROFILE_FILE=<run>.profraw && <generated_harness.exe>",
    collectTemplates: [
      "llvm-profdata.exe merge -sparse <run>.profraw -o <run>.profdata",
      "llvm-cov.exe export -format=text <generated_harness.exe> --instr-profile=<run>.profdata > <run>_llvm.json",
      "llvm-cov.exe report <generated_harness.exe> --instr-profile=<run>.profdata > <run>_report.txt",
      "llvm-cov.exe export -format=lcov <generated_harness.exe> --instr-profile=<run>.profdata > <run>.info"
    ],
    diagnostics: available ? [] : [{
      severity: "warning",
      code: "windows_local_mcdc_toolchain_unavailable",
      message: "Windows local residual MC/DC requires version-matched LLVM clang, lld-link, llvm-cov, and llvm-profdata with -fcoverage-mcdc support. Ask the user before installing LLVM.",
      source: "mcp",
      blocking: false,
      details: {
        missingTools,
        clangMajor,
        lldMajor,
        versionMatched,
        minimumVersionMet,
        mcdcFlagSupported
      }
    }],
    installPlan: available ? null : windowsLlvmInstallPlan()
  };
}

async function prepareWindowsLlvmToolchain(args = {}) {
  const environment = normalizeEnvironment(args.environment || {});
  const before = detectWindowsLocalMcdcToolchain(environment);
  const plan = before.installPlan || windowsLlvmInstallPlan();
  if (before.available) {
    return {
      schemaVersion: "perfectone.windows-local-mcdc.prepare.v1",
      status: "ready",
      executed: false,
      executedInstall: false,
      before,
      after: before,
      windowsLocalMcdc: before,
      installPlan: null,
      message: "Windows local LLVM/lld-link MC/DC toolchain is already ready."
    };
  }
  if (!args.installApproved) {
    return {
      schemaVersion: "perfectone.windows-local-mcdc.prepare.v1",
      status: "requires_user_approval",
      executed: false,
      executedInstall: false,
      before,
      windowsLocalMcdc: before,
      installPlan: plan,
      message: "Ask the user whether to install LLVM for Windows. Run this tool again with installApproved=true only after explicit approval."
    };
  }
  if (normalizeHostOs(processHostOs()) !== "windows") {
    return {
      schemaVersion: "perfectone.windows-local-mcdc.prepare.v1",
      status: "failed",
      executed: false,
      executedInstall: false,
      before,
      windowsLocalMcdc: before,
      installPlan: plan,
      diagnostics: [{
        severity: "error",
        code: "windows_llvm_install_requires_windows_host",
        message: "LLVM for Windows installation can only be executed on a Windows host.",
        source: "mcp",
        blocking: true
      }]
    };
  }
  const winget = resolveTool("winget", { hostOs: "windows" });
  const choco = resolveTool("choco", { hostOs: "windows" });
  let command = null;
  let installResult = null;
  if (winget) {
    command = [winget, "install", "--id", WINDOWS_LLVM_WINGET_ID, "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"];
    installResult = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: args.timeoutMs || 900000, windowsHide: true });
  } else if (choco) {
    command = [choco, "install", "llvm", "-y"];
    installResult = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: args.timeoutMs || 900000, windowsHide: true });
  } else {
    return {
      schemaVersion: "perfectone.windows-local-mcdc.prepare.v1",
      status: "failed",
      executed: false,
      executedInstall: false,
      before,
      windowsLocalMcdc: before,
      installPlan: plan,
      diagnostics: [{
        severity: "error",
        code: "windows_package_manager_not_found",
        message: "Neither winget nor choco was found. Install LLVM for Windows manually, then rerun toolchain detection.",
        source: "mcp",
        blocking: true
      }]
    };
  }
  const after = detectWindowsLocalMcdcToolchain(environment);
  return {
    schemaVersion: "perfectone.windows-local-mcdc.prepare.v1",
    status: after.available ? "ready" : "failed",
    executed: true,
    executedInstall: true,
    command,
    exitCode: installResult.status ?? null,
    stdout: truncate(installResult.stdout || "", MAX_EXCERPT),
    stderr: truncate(installResult.stderr || "", MAX_EXCERPT),
    before,
    after,
    windowsLocalMcdc: after,
    installPlan: after.available ? null : plan,
    diagnostics: after.available ? [] : [{
      severity: "error",
      code: "windows_llvm_install_incomplete",
      message: "LLVM installer finished but the local MC/DC toolchain is still not ready. Restart the shell or add C:\\Program Files\\LLVM\\bin to PATH, then rerun detection.",
      source: "mcp",
      blocking: true
    }]
  };
}

function inspectDockerImage(dockerCommand, image) {
  if (!dockerCommand || !image) {
    return { image, exists: false, checked: false, exitCode: null, error: null };
  }
  const result = spawnSync(dockerCommand, ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  return {
    image,
    exists: result.status === 0,
    checked: true,
    exitCode: result.status ?? null,
    error: result.status === 0 ? null : truncate(result.stderr || result.stdout || "", 1000),
    daemonUnavailable: result.status !== 0 && /dockerDesktopLinuxEngine|daemon|pipe|connect|Cannot connect/i.test(`${result.stderr || ""}\n${result.stdout || ""}`)
  };
}

function dockerInfo(dockerCommand) {
  if (!dockerCommand) return { ok: false, error: "docker command not found" };
  const result = spawnSync(dockerCommand, ["info"], {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    exitCode: result.status ?? null,
    error: result.status === 0 ? null : truncate(result.stderr || result.stdout || "", 1500)
  };
}

function startDockerDesktopOnWindows() {
  if (process.platform !== "win32") return { attempted: false, reason: "not_windows" };
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$svc=Get-Service -Name com.docker.service -ErrorAction SilentlyContinue",
    "if($svc -and $svc.Status -ne 'Running'){Start-Service -Name com.docker.service}",
    "$exe='C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'",
    "if(Test-Path $exe){Start-Process -FilePath $exe -WindowStyle Hidden}"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true
  });
  return {
    attempted: true,
    exitCode: result.status ?? null,
    stdout: truncate(result.stdout || "", 1000),
    stderr: truncate(result.stderr || "", 1000)
  };
}

function ensureDockerDaemon(dockerCommand, { autoStart = false, timeoutMs = 90000 } = {}) {
  const before = dockerInfo(dockerCommand);
  if (before.ok || !autoStart) return { ready: before.ok, before, autoStartAttempt: null, after: before };
  const autoStartAttempt = startDockerDesktopOnWindows();
  const deadline = Date.now() + timeoutMs;
  let after = before;
  while (Date.now() < deadline) {
    after = dockerInfo(dockerCommand);
    if (after.ok) break;
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{}, 3000)"], { timeout: 5000, windowsHide: true });
  }
  return { ready: after.ok, before, autoStartAttempt, after };
}

function dockerPreparationStatus(environment = {}, toolchain = null) {
  const env = normalizeEnvironment(environment);
  const configuredImage = String(process.env.PERFECTONE_KLEE_IMAGE || "").trim() || null;
  const cacheDisabled = envFlagEnabled("PERFECTONE_DISABLE_DOCKER_IMAGE_CACHE");
  const docker = toolchain?.docker || toolCapability("docker", { ...env, language: "c" });
  const status = {
    requiredForWindowsC: env.hostOs === "windows" && !env.isEmbeddedTarget,
    preparedImage: PREPARED_KLEE_DOCKER_IMAGE,
    baseImage: BASE_KLEE_DOCKER_IMAGE,
    configuredImage,
    cacheDisabled,
    estimatedFirstPrepareTime: DOCKER_PREP_ESTIMATE,
    installCommand: env.hostOs === "windows"
      ? "winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements"
      : (env.hostOs === "macos" ? "brew install --cask docker" : "Install Docker Engine with your distribution package manager, then start the Docker daemon."),
    setupCommands: [
      "docker pull klee/klee:v3.2",
      `docker image inspect ${PREPARED_KLEE_DOCKER_IMAGE}`
    ],
    dockerAvailable: Boolean(docker?.available),
    dockerCommand: docker?.command || null,
    dockerDaemonReady: null,
    dockerDaemonAutoStart: null,
    preparedImagePresent: null,
    baseImagePresent: null,
    firstRunWillPrepare: false,
    repeatedPrepareLikely: false,
    checked: false,
    status: "not_required",
    message: "Docker prepared image is not required for this request."
  };

  if (!status.requiredForWindowsC) return status;

  if (!docker?.available) {
    return {
      ...status,
      status: "docker_unavailable",
      message: `Windows C coverage defaults to Docker, but Docker was not found. Install Docker Desktop before running PerfectOne C coverage: ${status.installCommand}`
    };
  }

  if (!shouldProbeHost(env.hostOs)) {
    return {
      ...status,
      status: "not_probed",
      message: `Docker runner was explicitly selected and uses prepared image ${PREPARED_KLEE_DOCKER_IMAGE}. If it is missing on the target host, the first run prepares it in ${DOCKER_PREP_ESTIMATE}.`
    };
  }

  const daemon = ensureDockerDaemon(docker.command, {
    autoStart: Boolean(env.autoStartDocker || env.dockerAutoStart),
    timeoutMs: Number(env.dockerAutoStartTimeoutMs || 90000)
  });
  if (!daemon.ready) {
    return {
      ...status,
      checked: true,
      dockerDaemonReady: false,
      dockerDaemonAutoStart: daemon.autoStartAttempt,
      status: "docker_daemon_unavailable",
      message: `Docker is required for Windows C coverage, but the Docker daemon is not reachable. ${daemon.autoStartAttempt ? "Automatic Docker Desktop startup was attempted but did not become ready." : "Start Docker Desktop or rerun with Docker auto-start enabled."}`,
      inspect: { daemon }
    };
  }

  const prepared = inspectDockerImage(docker.command, PREPARED_KLEE_DOCKER_IMAGE);
  const base = inspectDockerImage(docker.command, BASE_KLEE_DOCKER_IMAGE);
  const configured = configuredImage ? inspectDockerImage(docker.command, configuredImage) : null;
  const configuredMissing = Boolean(configured && !configured.exists);
  const firstRunWillPrepare = !configuredImage && !cacheDisabled && !prepared.exists;
  const repeatedPrepareLikely = !configuredImage && cacheDisabled && !prepared.exists;
  let message = `Explicit Docker C verification uses prepared image ${PREPARED_KLEE_DOCKER_IMAGE}.`;
  let state = "ready";
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
  } else if (prepared.exists) {
    message = `Prepared Docker image ${PREPARED_KLEE_DOCKER_IMAGE} is present. Windows C coverage should skip LLVM/lcov bootstrap.`;
  }

  return {
    ...status,
    checked: true,
    dockerDaemonReady: true,
    dockerDaemonAutoStart: daemon.autoStartAttempt,
    preparedImagePresent: prepared.exists,
    baseImagePresent: base.exists,
    configuredImagePresent: configured ? configured.exists : null,
    firstRunWillPrepare,
    repeatedPrepareLikely,
    status: state,
    message,
    inspect: {
      prepared,
      base,
      configured
    }
  };
}

function requiredToolsForLanguage(language, environment = {}) {
  const targetOs = normalizeTargetOs(environment.targetOs, normalizeHostOs(environment.hostOs));
  if (EMBEDDED_TARGETS.has(targetOs)) {
    return ["cmake", "ninja", "pkg-config"];
  }
  const normalized = String(language || "").toLowerCase();
  if (normalized === "c" && normalizeHostOs(environment.hostOs) === "windows") return ["docker"];
  if (["c", "cpp"].includes(normalized)) return ["gcc", "g++", "clang", "clang++", "gcov", "llvm-cov", "llvm-profdata", "cmake", "ninja", "klee", "pkg-config"];
  if (normalized === "python") return ["python", "python3", "pytest", "coverage"];
  if (["js", "ts", "javascript", "typescript"].includes(normalized)) return ["node", "npm"];
  if (normalized === "go") return ["go"];
  if (normalized === "java") return ["java", "javac", "mvn", "gradle"];
  if (normalized === "csharp") return ["dotnet"];
  if (normalized === "rust") return ["cargo", "rustc"];
  if (normalized === "ruby") return ["ruby", "bundle"];
  return ["gcc", "clang", "gcov", "llvm-cov", "llvm-profdata", "cmake", "ninja", "docker"];
}

function detectLocalToolchain(environment = {}) {
  const env = normalizeEnvironment(environment);
  const tools = Array.from(new Set([...requiredToolsForLanguage("c", env), ...requiredToolsForLanguage(environment.language, env)]));
  const capabilities = tools.map((tool) => toolCapability(tool, { ...env, language: environment.language }));
  const dockerCapability = toolCapability("docker", { ...env, language: environment.language });
  return {
    hostOs: env.hostOs,
    targetOs: env.targetOs,
    wslDistro: null,
    tools: capabilities,
    coverageTools: capabilities.filter((item) => ["gcov", "llvm-cov", "llvm-profdata"].includes(item.name)),
    compilers: capabilities.filter((item) => ["gcc", "clang"].includes(item.name)),
    windowsLocalMcdc: env.hostOs === "windows" ? detectWindowsLocalMcdcToolchain(env) : null,
    nativeKlee: capabilities.find((item) => item.name === "klee") || null,
    wsl: null,
    wslPerfectOneCli: null,
    docker: dockerCapability
  };
}

function findUpwards(start, filename) {
  let current = path.resolve(start);
  if (existsSync(current)) {
    try {
      if (!statSync(current).isDirectory()) current = path.dirname(current);
    } catch {
      current = path.dirname(current);
    }
  }
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, filename);
    if (existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function latestMtimeMsForFiles(files) {
  let latest = 0;
  for (const file of files || []) {
    try {
      latest = Math.max(latest, statSync(file).mtimeMs);
    } catch {
      // ignore unreadable marker files
    }
  }
  return latest;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function previousRunRootFromMarker(filePath) {
  const normalized = path.normalize(filePath);
  const parts = normalized.split(path.sep);
  const reportIndex = parts.lastIndexOf("mcp_reports");
  if (reportIndex > 0) return parts.slice(0, reportIndex).join(path.sep);
  const jobIndex = parts.lastIndexOf("coverage_jobs");
  if (jobIndex > 1) {
    const status = readJsonSync(filePath);
    if (status?.outDir) return path.resolve(status.outDir);
    return parts.slice(0, jobIndex - 1).join(path.sep);
  }
  const perfectoneIndex = parts.lastIndexOf(".perfectone");
  if (perfectoneIndex > 0) {
    const subdir = String(parts[perfectoneIndex + 1] || "").toLowerCase();
    if (["docker_logs", "output"].includes(subdir)) {
      return parts.slice(0, perfectoneIndex - 1).join(path.sep);
    }
    return parts.slice(0, perfectoneIndex).join(path.sep);
  }
  return path.dirname(filePath);
}

function summarizePreviousRunTestcaseExecution(outDir, status, manifest) {
  const progress = summarizeCoverageProgress(outDir, status?.sourceTargetFilter || null);
  const files = walkFilesSync(outDir, { maxFiles: 20000, maxDepth: 10 });
  const count = (predicate) => files.filter(predicate).length;
  const testcaseCounts = manifest?.testcase_counts || status?.testcaseCounts || status?.coverageExecution?.performance?.testcaseCounts || null;
  return {
    phase: progress.phase,
    totalFunctions: progress.totalFunctions,
    kleeCompleted: progress.kleeCompleted,
    kleePartial: progress.kleePartial,
    kleeTimedOut: progress.kleeTimedOut,
    nativeReplayCompleted: progress.nativeReplayCompleted,
    nativeReplayCrash: progress.nativeReplayCrash,
    nativeReplayTimeout: progress.nativeReplayTimeout,
    profrawCount: progress.profrawCount,
    mergeCompleted: progress.mergeCompleted,
    coverageInfoFiles: count((file) => /[\\/]coverage_results[\\/].*coverage_.*\.info$/i.test(file)),
    kleeStatusFiles: count((file) => /(?:^|[\\/])klee_run\.status(?:\.json)?$/i.test(file)),
    nativeStatusFiles: count((file) => /(?:^|[\\/])native_run\.status(?:\.json)?$/i.test(file)),
    generatedKleeTests: count((file) => /\.(ktest)$/i.test(file)),
    decodedInputFiles: count((file) => /(?:^|[\\/])input_test.*\.(txt|json|xml)$/i.test(file)),
    residualHarnesses: count((file) => /[\\/]coding_agent_residual[\\/].*\.(c|cpp|h)$/i.test(file)),
    residualCoverageArtifacts: count((file) => /[\\/]coding_agent_residual[\\/].*\.(profraw|profdata|info|json|html|txt)$/i.test(file)),
    testcaseCounts
  };
}

function summarizePreviousCRun(outDir, projectRoot) {
  const markerFiles = [
    path.join(outDir, "coverage_manifest.json"),
    path.join(outDir, "coverage_partial_manifest.json"),
    path.join(outDir, "coverage_input_file.info"),
    path.join(outDir, "ir.json"),
    path.join(outDir, "perfectone_unit_verify.log"),
    path.join(outDir, "mcp_reports", "perfectone_mcp_report.json"),
    path.join(outDir, "mcp_reports", "perfectone_mcp_report.html")
  ].filter(pathExists);
  const jobFiles = walkFilesSync(path.join(outDir, ".perfectone", "coverage_jobs"), { maxFiles: 200, maxDepth: 4 })
    .filter((file) => /(?:^|[\\/])status\.json$/i.test(file) || /(?:^|[\\/])progress\.json$/i.test(file));
  const executionMarkerFiles = walkFilesSync(outDir, { maxFiles: 500, maxDepth: 6 })
    .filter((file) => /(?:^|[\\/])(?:klee_run|native_run|klee_compile)\.status(?:\.json)?$/i.test(file));
  const allMarkers = [...markerFiles, ...jobFiles, ...executionMarkerFiles];
  if (allMarkers.length === 0) return null;

  const report = readJsonSync(path.join(outDir, "mcp_reports", "perfectone_mcp_report.json")) || {};
  const manifest = readJsonSync(path.join(outDir, "coverage_manifest.json")) || readJsonSync(path.join(outDir, "coverage_partial_manifest.json")) || {};
  const statusPath = jobFiles
    .filter((file) => /(?:^|[\\/])status\.json$/i.test(file))
    .sort((a, b) => latestMtimeMsForFiles([b]) - latestMtimeMsForFiles([a]))[0] || null;
  const status = statusPath ? (readJsonSync(statusPath) || {}) : {};
  const progressPath = statusPath ? path.join(path.dirname(statusPath), "progress.json") : null;
  const mtimeMs = latestMtimeMsForFiles(allMarkers);
  const coverage = report.coverage || {};
  const testcaseExecution = summarizePreviousRunTestcaseExecution(outDir, status, manifest);
  return {
    outDir,
    relativeOutDir: path.relative(projectRoot, outDir) || ".",
    runId: report.runId || status.runId || manifest.run_id || manifest.runId || null,
    status: report.status || status.status || manifest.status || (pathExists(path.join(outDir, "coverage_input_file.info")) ? "coverage_artifacts_present" : "artifact_generation_present"),
    lastModified: mtimeMs ? new Date(mtimeMs).toISOString() : null,
    hasIr: pathExists(path.join(outDir, "ir.json")),
    hasCoverageManifest: pathExists(path.join(outDir, "coverage_manifest.json")),
    hasPartialManifest: pathExists(path.join(outDir, "coverage_partial_manifest.json")),
    hasLcov: pathExists(path.join(outDir, "coverage_input_file.info")),
    hasHtmlReport: pathExists(path.join(outDir, "mcp_reports", "perfectone_mcp_report.html")),
    hasCoverageHtml: pathExists(path.join(outDir, "html_cov", "input_file", "index.html")),
    testcaseExecution,
    coverage: {
      line: coverage.line ?? null,
      branch: coverage.branch ?? null,
      function: coverage.function ?? null,
      mcdc: coverage.mcdc ?? null
    },
    jobId: status.jobId || null,
    statusPath,
    progressPath: progressPath && pathExists(progressPath) ? progressPath : null,
    reuseArgs: {
      reusePreviousRun: true,
      previousRunOutDir: outDir,
      outDir,
      statusPath,
      progressPath: progressPath && pathExists(progressPath) ? progressPath : null,
      jobId: status.jobId || null
    }
  };
}

function discoverPreviousCRuns(projectRoot, options = {}) {
  const root = path.resolve(projectRoot || workspaceRoot);
  const maxResults = Math.max(1, Math.min(Number(options.maxResults || options.maxPreviousRuns || 10) || 10, 50));
  const scanRoots = [
    options.outDir ? path.resolve(root, options.outDir) : null,
    path.join(root, ".perfectone"),
    path.join(root, "Output"),
    path.join(root, "output"),
    path.join(root, "perfectone-output"),
    path.join(root, "perfectone_output")
  ].filter(Boolean);
  const markerNames = new Set([
    "coverage_manifest.json",
    "coverage_partial_manifest.json",
    "coverage_input_file.info",
    "ir.json",
    "perfectone_unit_verify.log",
    "perfectone_mcp_report.json",
    "perfectone_mcp_report.html",
    "status.json",
    "progress.json",
    "klee_run.status",
    "klee_run.status.json",
    "native_run.status",
    "native_run.status.json",
    "klee_compile.status",
    "klee_compile.status.json"
  ]);
  const candidateDirs = new Map();
  for (const scanRoot of scanRoots) {
    if (!pathExists(scanRoot)) continue;
    const files = walkFilesSync(scanRoot, { maxFiles: 20000, maxDepth: 10 });
    for (const file of files) {
      if (!markerNames.has(path.basename(file))) continue;
      const runRoot = previousRunRootFromMarker(file);
      if (!runRoot) continue;
      candidateDirs.set(path.resolve(runRoot), true);
    }
  }
  const runs = Array.from(candidateDirs.keys())
    .map((dir) => summarizePreviousCRun(dir, root))
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, maxResults);
  return {
    found: runs.length > 0,
    count: runs.length,
    defaultAction: "new_run",
    requiresUserChoice: runs.length > 0,
    prompt: runs.length > 0
      ? "Previous PerfectOne C verification results were found. Ask whether to reuse one of them; if the user does not explicitly choose reuse, start a new run."
      : null,
    choices: runs.length > 0 ? ["new_run", "reuse_previous_run"] : [],
    runs
  };
}

function detectCProject(projectRoot, environment = {}, options = {}) {
  const root = path.resolve(projectRoot || workspaceRoot);
  const found = [];
  const stack = [root];
  let visitedDirs = 0;
  while (stack.length > 0 && found.length < 500 && visitedDirs < 1000) {
    const current = stack.pop();
    visitedDirs += 1;
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && isSkippedDir(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (/\.(c|h|i)$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }
  const sampleFiles = found.slice(0, 20);
  const compileDb = existsSync(path.join(root, "compile_commands.json"))
    ? path.join(root, "compile_commands.json")
    : (sampleFiles[0] ? findUpwards(sampleFiles[0], "compile_commands.json") : null);
  return {
    projectRoot: root,
    isCProject: found.length > 0,
    compileDb,
    sourceCount: found.filter((file) => /\.(c|cc|cpp|cxx)$/i.test(file)).length,
    headerCount: found.filter((file) => /\.(h|hh|hpp|hxx)$/i.test(file)).length,
    sampleFiles,
    scan: { visitedDirs, skippedLargeDirectories: Array.from(SKIP_DIRS).sort() },
    previousRuns: discoverPreviousCRuns(root, options),
    localToolchain: detectLocalToolchain({ ...environment, language: "c" })
  };
}

function detectBuildMetadata(projectRoot, sourceFiles = []) {
  const root = path.resolve(projectRoot || workspaceRoot);
  const sample = Array.isArray(sourceFiles) && sourceFiles[0]
    ? (path.isAbsolute(sourceFiles[0]) ? sourceFiles[0] : path.resolve(root, sourceFiles[0]))
    : null;
  const candidates = {
    compileDb: existsSync(path.join(root, "compile_commands.json")) ? path.join(root, "compile_commands.json") : (sample ? findUpwards(sample, "compile_commands.json") : null),
    cmake: existsSync(path.join(root, "CMakeLists.txt")) ? path.join(root, "CMakeLists.txt") : (sample ? findUpwards(sample, "CMakeLists.txt") : null),
    packageJson: existsSync(path.join(root, "package.json")) ? path.join(root, "package.json") : (sample ? findUpwards(sample, "package.json") : null),
    pyproject: existsSync(path.join(root, "pyproject.toml")) ? path.join(root, "pyproject.toml") : (sample ? findUpwards(sample, "pyproject.toml") : null),
    goMod: existsSync(path.join(root, "go.mod")) ? path.join(root, "go.mod") : (sample ? findUpwards(sample, "go.mod") : null),
    pom: existsSync(path.join(root, "pom.xml")) ? path.join(root, "pom.xml") : (sample ? findUpwards(sample, "pom.xml") : null),
    gradle: existsSync(path.join(root, "build.gradle")) ? path.join(root, "build.gradle") : (sample ? findUpwards(sample, "build.gradle") : null),
    dotnet: null,
    cargo: existsSync(path.join(root, "Cargo.toml")) ? path.join(root, "Cargo.toml") : (sample ? findUpwards(sample, "Cargo.toml") : null),
    gemfile: existsSync(path.join(root, "Gemfile")) ? path.join(root, "Gemfile") : (sample ? findUpwards(sample, "Gemfile") : null)
  };
  try {
    const slnOrCsproj = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isFile() && /\.(sln|csproj)$/i.test(entry.name));
    if (slnOrCsproj) candidates.dotnet = path.join(root, slnOrCsproj.name);
  } catch {
    candidates.dotnet = null;
  }
  return candidates;
}

function blockingDiagnosticsForEnvironment({ language, environment, toolchain, buildMetadata }) {
  const diagnostics = [];
  const env = normalizeEnvironment(environment);
  const missingTools = (toolchain.tools || []).filter((item) => !item.available).map((item) => item.name);
  if (env.isEmbeddedTarget && !embeddedContextReady(env, { compileDb: buildMetadata.compileDb })) {
    diagnostics.push({
      severity: "error",
      code: "target_toolchain_context_required",
      message: "Embedded target requires compile_commands.json, cmakeToolchainFile, or compiler/toolchainPrefix plus sysroot before execution.",
      source: "mcp",
      blocking: true
    });
  }
  if (String(language || "").toLowerCase() === "c") {
    if (env.hostOs === "windows" && missingTools.includes("docker")) {
      diagnostics.push({
        severity: "error",
        code: "needs_docker_setup",
        message: "Windows C KLEE/MC/DC coverage defaults to Docker. Install Docker Desktop or configure Docker before running PerfectOne C coverage.",
        source: "mcp",
        blocking: true
      });
    }
    if (["linux", "macos"].includes(env.hostOs) && ["klee", "clang", "llvm-cov", "llvm-profdata"].some((tool) => missingTools.includes(tool)) && missingTools.includes("docker")) {
      diagnostics.push({
        severity: "error",
        code: "needs_toolchain_setup",
        message: "Native KLEE/LLVM tools are incomplete and Docker was not explicitly selected.",
        source: "mcp",
        blocking: true
      });
    }
  }
  return diagnostics;
}

function detectToolchainEnvironment(args = {}) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const language = String(args.language || "unknown").toLowerCase();
  const environment = normalizeEnvironment(args.environment || {});
  const reportedEnvironment = language === "c" && environment.hostOs === "windows"
    ? { ...environment, wslDistro: null }
    : environment;
  const sourceFiles = Array.isArray(args.sourceFiles) ? args.sourceFiles : [];
  const toolchain = detectLocalToolchain({ ...environment, language });
  const languageTools = requiredToolsForLanguage(language, environment);
  const selectedTools = toolchain.tools.filter((item) => languageTools.includes(item.name));
  const missingTools = selectedTools.filter((item) => !item.available).map((item) => item.name);
  const buildMetadata = detectBuildMetadata(projectRoot, sourceFiles);
  const diagnostics = blockingDiagnosticsForEnvironment({ language, environment, toolchain: { ...toolchain, tools: selectedTools }, buildMetadata });
  const dockerPreparation = language === "c" ? dockerPreparationStatus(environment, { ...toolchain, tools: selectedTools }) : null;
  if (dockerPreparation?.status === "docker_daemon_unavailable") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "docker_daemon_unavailable",
      message: dockerPreparation.message,
      source: "mcp",
      blocking: true
    });
  } else if (dockerPreparation?.firstRunWillPrepare || dockerPreparation?.repeatedPrepareLikely || dockerPreparation?.status === "configured_image_missing") {
    diagnostics.push({
      severity: dockerPreparation.status === "configured_image_missing" ? "error" : "warning",
      code: dockerPreparation.status === "configured_image_missing" ? "docker_configured_image_missing" : "windows_docker_prepared_image_missing",
      message: dockerPreparation.message,
      source: "mcp",
      blocking: dockerPreparation.status === "configured_image_missing"
    });
  }
  const setupPrompt = setupPromptForEnvironment({ language, environment, missingTools, reason: diagnostics.find((item) => item.blocking)?.code || "" });
  return {
    schemaVersion: "unitverify.toolchain-environment.v1",
    status: diagnostics.some((item) => item.blocking) ? "blocked" : (missingTools.length > 0 ? "needs_toolchain_setup" : "ready"),
    projectRoot,
    language,
    environment: reportedEnvironment,
    host: {
      actualOs: processHostOs(),
      probed: shouldProbeHost(environment.hostOs)
    },
    tools: selectedTools,
    missingTools,
    cCoverageRunnerSelection: language === "c" ? {
      defaultRunner: environment.hostOs === "windows" ? "docker" : (["linux", "macos"].includes(environment.hostOs) ? "local" : "auto"),
      runnerPolicy: "os-default",
      dockerRequiresExplicitSelection: false,
      wslDisabled: true,
      windowsCliOrchestratesWsl: false,
      dockerRunsKleeBaseline: environment.hostOs === "windows"
    } : null,
    cResidualExecutionStrategy: language === "c" ? {
      defaultStrategy: environment.hostOs === "windows" ? "docker-klee-then-windows-local-llvm-mcdc" : "local-native-coverage",
      baselineKleePreferred: environment.hostOs === "windows" ? "docker" : "local",
      fallbackOrder: environment.hostOs === "windows"
        ? ["docker-klee-baseline", "windows-local-llvm-residual-mcdc", "local-no-klee-coverage"]
        : ["local-klee-baseline", "explicit-docker-klee", "local-no-klee-coverage"],
      windowsLocalMcdc: toolchain.windowsLocalMcdc || null,
      installRequiresUserApproval: Boolean(toolchain.windowsLocalMcdc?.installPlan)
    } : null,
    wslPerfectOneCli: null,
    buildMetadata,
    dockerPreparation,
    setupPrompt,
    diagnostics,
    blockingDiagnostics: diagnostics.filter((item) => item.blocking)
  };
}

function perfectOneCliDiscovery(args = {}) {
  const root = path.resolve(args.workspaceRoot || workspaceRoot);
  const environment = normalizeEnvironment(args.environment || {});
  const hostOs = environment.hostOs;
  const candidates = perfectOneCliCandidates(args.perfectoneCli, { hostOs, workspaceRoot: root }).map((candidate) => ({
    path: candidate,
    exists: existsSync(candidate)
  }));
  const hostCliExists = candidates.some((item) => item.exists);
  const windowsLocalMcdc = hostOs === "windows" ? detectWindowsLocalMcdcToolchain(environment) : null;
  const prompt = [
    `Discover a prebuilt PerfectOne CLI for host OS ${hostOs}.`,
    "The plugin does not build PerfectOne binaries. Provide perfectoneCli/PERFECTONE_CLI or place the matching prebuilt CLI under bin/<platform>.",
    hostOs === "windows" ? "Windows C coverage uses ClangParserForWin.exe with Docker for PerfectOne KLEE execution. Coding Agent residual/native replay and MC/DC aggregation should prefer Windows local LLVM/lld-link when ready. WSL is disabled for this plugin path." : "",
    hostOs === "linux" ? "Linux hosts use a prebuilt ClangParserForLinux when supplied or found." : "",
    hostOs === "macos" ? "macOS hosts use a prebuilt ClangParserForMac/UnitTester when supplied or found." : ""
  ].filter(Boolean).join(" ");
  return {
    schemaVersion: "perfectone.cli.discovery.v1",
    status: hostCliExists ? "ready" : "cli_not_found",
    workspaceRoot: root,
    pluginRoot,
    hostOs,
    wslDistro: null,
    cCoverageRunnerSelection: hostOs === "windows" ? {
      defaultRunner: "docker",
      dockerRequiresExplicitSelection: false,
      windowsCliOrchestratesWsl: false,
      wslDisabled: true,
      directWslLinuxCliRequired: false,
      residualMcdcDefault: "windows-local-llvm-lld-link"
    } : {
      defaultRunner: ["linux", "macos"].includes(hostOs) ? "local" : "auto",
      dockerRequiresExplicitSelection: true,
      windowsCliOrchestratesWsl: false,
      directWslLinuxCliRequired: false
    },
    candidates,
    wslCli: null,
    wslCliCandidates: [],
    windowsLocalMcdc,
    setupPrompt: prompt,
    commands: []
  };
}

async function preparePerfectOneCli(args = {}) {
  const discovery = perfectOneCliDiscovery(args);
  return {
    ...discovery,
    schemaVersion: "perfectone.cli.prepare.v1",
    executed: false,
    executeIgnored: Boolean(args.execute),
    diagnostics: [{
      severity: discovery.status === "ready" ? "info" : "error",
      code: discovery.status === "ready" ? "perfectone_cli_discovered" : "perfectone_cli_not_found",
      message: discovery.status === "ready"
        ? "Using an existing PerfectOne CLI binary. The plugin does not build CLI binaries."
        : "PerfectOne CLI binary was not found. Provision it outside the plugin, then provide perfectoneCli/PERFECTONE_CLI or place it under bin/<platform>.",
      source: "mcp",
      blocking: discovery.status !== "ready"
    }]
  };
}

function latestExistingSubdir(root) {
  if (!pathExists(root)) return null;
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name))
      .sort((a, b) => a.localeCompare(b))
      .pop() || null;
  } catch {
    return null;
  }
}

function windowsSdkIncludeDirs() {
  if (process.platform !== "win32") return [];
  const kitsRoot = String.raw`C:\Program Files (x86)\Windows Kits\10\Include`;
  const latest = latestExistingSubdir(kitsRoot);
  if (!latest || !pathExists(path.join(latest, "ucrt", "stdio.h"))) return [];
  const dirs = [];
  for (const subdir of ["ucrt", "shared", "um", "winrt"]) {
    const dir = path.join(latest, subdir);
    if (pathExists(dir)) pushUnique(dirs, dir);
  }
  return dirs;
}

function msvcIncludeDirs() {
  if (process.platform !== "win32") return [];
  const roots = [
    String.raw`C:\Program Files\Microsoft Visual Studio\2022`,
    String.raw`C:\Program Files (x86)\Microsoft Visual Studio\2022`
  ];
  const dirs = [];
  for (const root of roots) {
    if (!pathExists(root)) continue;
    let editions = [];
    try {
      editions = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const edition of editions) {
      const msvcRoot = path.join(root, edition, "VC", "Tools", "MSVC");
      const latest = latestExistingSubdir(msvcRoot);
      const includeDir = latest ? path.join(latest, "include") : null;
      if (pathExists(includeDir)) pushUnique(dirs, includeDir);
    }
  }
  return dirs;
}

function includeEnvDirs() {
  const raw = process.env.INCLUDE || "";
  const dirs = [];
  for (const item of raw.split(";")) {
    const dir = item.trim();
    if (pathExists(dir)) pushUnique(dirs, path.resolve(dir));
  }
  return dirs;
}

function envPathDirs(name, separator = path.delimiter) {
  const raw = process.env[name] || "";
  const dirs = [];
  for (const item of raw.split(separator)) {
    const dir = item.trim();
    if (pathExists(dir)) pushUnique(dirs, path.resolve(dir));
  }
  return dirs;
}

function compilerSystemIncludeDirs(compiler, language = "c") {
  if (!compiler || !existsSync(compiler)) return [];
  const langArg = language === "cpp" ? "c++" : "c";
  const completed = spawnSync(compiler, ["-E", "-x", langArg, "-", "-v"], {
    input: "",
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  const text = `${completed.stdout || ""}\n${completed.stderr || ""}`;
  const lines = text.split(/\r?\n/);
  const dirs = [];
  let inSearchList = false;
  for (const line of lines) {
    if (line.includes("#include <...> search starts here:")) {
      inSearchList = true;
      continue;
    }
    if (inSearchList && line.includes("End of search list.")) break;
    if (!inSearchList) continue;
    const dir = line.trim();
    if (dir && pathExists(dir)) pushUnique(dirs, path.resolve(dir));
  }
  return dirs;
}

function macosSdkIncludeDirs() {
  if (process.platform !== "darwin") return [];
  const completed = spawnSync("xcrun", ["--show-sdk-path"], { encoding: "utf8", timeout: 10000 });
  const sdk = `${completed.stdout || ""}`.trim();
  const dirs = [];
  if (sdk && pathExists(sdk)) {
    for (const rel of ["usr/include", "System/Library/Frameworks"]) {
      const dir = path.join(sdk, rel);
      if (pathExists(dir)) pushUnique(dirs, dir);
    }
  }
  for (const dir of ["/opt/homebrew/opt/llvm/include", "/usr/local/opt/llvm/include"]) {
    if (pathExists(dir)) pushUnique(dirs, dir);
  }
  return dirs;
}

function explicitEnvironmentIncludeContext(environment = {}) {
  const includeDirs = [];
  const systemIncludeDirs = [];
  const libraryDirs = [];
  const defines = [];
  const linkArgs = [];
  for (const dir of environment.includeDirs || []) if (pathExists(dir)) pushUnique(includeDirs, path.resolve(dir));
  for (const dir of environment.systemIncludeDirs || []) if (pathExists(dir)) pushUnique(systemIncludeDirs, path.resolve(dir));
  for (const dir of environment.libraryDirs || []) if (pathExists(dir)) pushUnique(libraryDirs, path.resolve(dir));
  for (const def of environment.defines || []) pushUnique(defines, def);
  for (const arg of environment.linkArgs || []) pushUnique(linkArgs, arg);
  return { includeDirs, systemIncludeDirs, libraryDirs, defines, linkArgs };
}

function embeddedContextReady(environment = {}, request = {}) {
  if (request.compileDb || environment.compileDb) return true;
  if (environment.cmakeToolchainFile) return true;
  const hasCompiler = Boolean(environment.compilerPath || environment.compiler || environment.toolchainPrefix);
  return hasCompiler && Boolean(environment.sysroot);
}

function setupPromptForEnvironment({ language = "c", environment = {}, missingTools = [], reason = "" }) {
  const env = normalizeEnvironment(environment);
  const parts = [];
  parts.push(`Host OS: ${env.hostOs}; target OS: ${env.targetOs}; language: ${language || "unknown"}.`);
  if (env.isEmbeddedTarget) {
    parts.push("Provide the embedded target toolchain context before execution: chip/board, RTOS or bare-metal runtime, cross compiler path or prefix, sysroot, startup object, linker script, include/library roots, defines, and exact compile/link flags.");
    parts.push("Preferred inputs are compile_commands.json or a CMake toolchain file. If those do not exist, pass compilerPath or toolchainPrefix plus sysroot and compileArgs/linkArgs.");
  } else if (language === "c") {
    if (env.hostOs === "windows") parts.push("Windows C verification defaults to ClangParserForWin.exe with Docker for PerfectOne KLEE testcase generation. Windows local LLVM/lld-link is the preferred Coding Agent residual native replay and MC/DC aggregation path. WSL is disabled because artifact sync overhead is too high for this workflow.");
    if (env.hostOs === "linux") parts.push("Linux C verification prefers native PerfectOne+KLEE. Install clang/LLVM, llvm-cov, llvm-profdata, KLEE, CMake/Ninja, and project libraries; Docker is used only when explicitly selected.");
    if (env.hostOs === "macos") parts.push("macOS C verification prefers native PerfectOne+KLEE when available. Install Xcode Command Line Tools, Homebrew LLVM/KLEE where needed, CMake/Ninja, and project libraries; Docker is used only when explicitly selected.");
  } else {
    parts.push("Use the project-native compiler, package manager, test framework, and coverage tool for this language. Provide dependency install commands and build/test options before declaring a tooling blocker.");
  }
  if (missingTools.length > 0) {
    parts.push(`Missing tools: ${missingTools.join(", ")}.`);
  }
  if (reason) parts.push(`Blocker: ${reason}.`);
  return parts.join(" ");
}

function findJulietCRoot(inputPath) {
  let current = path.resolve(inputPath || "");
  if (!current) return null;
  try {
    if (!statSync(current).isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  for (let i = 0; i < 16 && current && current !== path.dirname(current); i += 1) {
    if (
      pathExists(path.join(current, "testcasesupport", "std_testcase.h")) &&
      pathExists(path.join(current, "testcases"))
    ) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function compileArgumentsForSource(sourceFile, language, inferred) {
  const args = ["clang"];
  args.push(language === "cpp" ? "-std=c++17" : "-std=gnu99");
  for (const dir of inferred.includeDirs) {
    args.push("-I", dir);
  }
  for (const dir of inferred.systemIncludeDirs) {
    args.push("-isystem", dir);
  }
  for (const def of inferred.defines) {
    args.push(`-D${def}`);
  }
  for (const undef of inferred.undefines) {
    args.push(`-U${undef}`);
  }
  args.push(path.resolve(sourceFile));
  return args;
}

function inferCompileContext(projectRoot, request) {
  const environment = normalizeEnvironment(request.environment || {});
  if (request.compileDb) {
    return { generated: false, reason: "request_compile_db_present", compileDb: request.compileDb };
  }
  const sourceFiles = Array.isArray(request.sourceFiles) ? request.sourceFiles : [];
  if (sourceFiles.length < 1) {
    return { generated: false, reason: "no_source_files" };
  }
  if (environment.isEmbeddedTarget && !embeddedContextReady(environment, request)) {
    return {
      generated: false,
      reason: "target_toolchain_context_required",
      environment,
      setupPrompt: setupPromptForEnvironment({
        language: request.language,
        environment,
        reason: "embedded target requires compile_commands.json, cmakeToolchainFile, or compiler/toolchainPrefix plus sysroot"
      }),
      diagnostics: [{
        severity: "error",
        code: "target_toolchain_context_required",
        message: "Embedded target compile context is incomplete. Provide compile DB, CMake toolchain file, or compiler/toolchainPrefix plus sysroot.",
        source: "mcp",
        blocking: true
      }]
    };
  }

  const includeDirs = [];
  const systemIncludeDirs = [];
  const libraryDirs = [];
  const defines = [];
  const undefines = [];
  const linkArgs = [];
  const entries = [];
  const julietRoots = [];
  const explicit = explicitEnvironmentIncludeContext(environment);
  for (const dir of explicit.includeDirs) pushUnique(includeDirs, dir);
  for (const dir of explicit.systemIncludeDirs) pushUnique(systemIncludeDirs, dir);
  for (const dir of explicit.libraryDirs) pushUnique(libraryDirs, dir);
  for (const def of explicit.defines) pushUnique(defines, def);
  for (const arg of explicit.linkArgs) pushUnique(linkArgs, arg);

  for (const source of sourceFiles) {
    const sourcePath = path.isAbsolute(source) ? source : path.resolve(projectRoot, source);
    const julietRoot = findJulietCRoot(sourcePath);
    if (julietRoot) {
      const supportDir = path.join(julietRoot, "testcasesupport");
      pushUnique(includeDirs, supportDir);
      pushUnique(julietRoots, julietRoot);
      pushUnique(defines, "_M_X64=100");
      pushUnique(defines, "_M_AMD64=100");
      pushUnique(undefines, "_M_IX86");
    }
    if (environment.hostOs === "windows" && shouldProbeHost(environment.hostOs)) {
      for (const dir of includeEnvDirs()) pushUnique(systemIncludeDirs, dir);
      for (const dir of windowsSdkIncludeDirs()) pushUnique(systemIncludeDirs, dir);
      for (const dir of msvcIncludeDirs()) pushUnique(systemIncludeDirs, dir);
    }
    if (["linux", "macos"].includes(environment.hostOs) && shouldProbeHost(environment.hostOs)) {
      for (const dir of envPathDirs("CPATH")) pushUnique(systemIncludeDirs, dir);
      for (const dir of envPathDirs("C_INCLUDE_PATH")) pushUnique(systemIncludeDirs, dir);
      for (const dir of envPathDirs("CPLUS_INCLUDE_PATH")) pushUnique(systemIncludeDirs, dir);
      const compiler = resolveTool(request.language === "cpp" ? "clang++" : "clang", environment) || resolveTool(request.language === "cpp" ? "g++" : "gcc", environment);
      for (const dir of compilerSystemIncludeDirs(compiler, request.language)) pushUnique(systemIncludeDirs, dir);
    }
    if (environment.hostOs === "macos" && shouldProbeHost(environment.hostOs)) {
      for (const dir of macosSdkIncludeDirs()) pushUnique(systemIncludeDirs, dir);
    }
    if (environment.sysroot) {
      const sysroot = path.resolve(environment.sysroot);
      for (const rel of ["include", "usr/include"]) {
        const dir = path.join(sysroot, rel);
        if (pathExists(dir)) pushUnique(systemIncludeDirs, dir);
      }
    }
    entries.push({
      directory: path.dirname(sourcePath),
      file: sourcePath,
      arguments: Array.isArray(environment.compileArgs) && environment.compileArgs.length > 0
        ? [...environment.compileArgs, sourcePath]
        : compileArgumentsForSource(sourcePath, request.language, { includeDirs, systemIncludeDirs, defines, undefines })
    });
  }

  if (includeDirs.length === 0 && systemIncludeDirs.length === 0 && defines.length === 0 && !environment.cmakeToolchainFile && !environment.compilerPath && !environment.compiler && !environment.toolchainPrefix) {
    return { generated: false, reason: `no_${environment.hostOs}_include_context_found`, environment };
  }

  return {
    generated: true,
    environment,
    includeDirs,
    systemIncludeDirs,
    libraryDirs,
    defines,
    undefines,
    linkArgs,
    julietRoots,
    entries
  };
}

async function maybeInjectCompileDb(projectRoot, request, tempDir) {
  const context = inferCompileContext(projectRoot, request);
  if (!context.generated) {
    return { request, context };
  }
  const compileDbPath = path.join(tempDir, "compile_commands.mcp-inferred.json");
  await writeFile(compileDbPath, JSON.stringify(context.entries, null, 2), "utf8");
  return {
    request: { ...request, compileDb: compileDbPath },
    context: {
      ...context,
      compileDb: compileDbPath,
      message: `MCP inferred ${context.environment?.hostOs || "local"} compile context because the request did not provide compileDb.`
    }
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathForCompare(filePath, projectRoot) {
  if (!filePath) return "";
  const normalized = path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readJsonIfExists(filePath) {
  const text = await readFullTextIfExists(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function functionEntriesFromIr(ir) {
  const functions = ir?.module?.functions;
  if (Array.isArray(functions)) {
    return functions.map((item) => [item?.name || item?.symbol || item?.target || "", item]);
  }
  if (functions && typeof functions === "object") {
    return Object.entries(functions);
  }
  return [];
}

async function extractFunctionNamesFromSources(resolvedSourceFiles) {
  const names = [];
  for (const sourcePath of resolvedSourceFiles) {
    const text = await readFullTextIfExists(sourcePath);
    for (const name of extractFunctionNamesFromCSource(text)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

async function extractFunctionNamesFromIr(projectRoot, irPath, resolvedSourceFiles, sourceDefinitionNames = []) {
  const ir = await readJsonIfExists(irPath);
  const sourceSet = new Set((resolvedSourceFiles || []).map((item) => normalizePathForCompare(item, projectRoot)));
  if (!ir || sourceSet.size < 1) {
    return { generated: false, reason: "ir_unavailable" };
  }

  const rawNames = [];
  for (const [key, item] of functionEntriesFromIr(ir)) {
    const name = item?.name || item?.symbol || item?.target || key;
    const file = item?.file || item?.sourceFile || item?.source_file || item?.location?.file || item?.loc?.file || null;
    if (!name || !file) continue;
    const normalizedFile = normalizePathForCompare(file, projectRoot);
    if (sourceSet.has(normalizedFile) && !rawNames.includes(String(name))) {
      rawNames.push(String(name));
    }
  }

  const sourceNameSet = new Set(sourceDefinitionNames || []);
  const guardedNames = sourceNameSet.size > 0
    ? rawNames.filter((name) => sourceNameSet.has(name))
    : rawNames;
  const names = guardedNames;

  if (names.length < 1) {
    return {
      generated: false,
      reason: rawNames.length > 0 ? "ir_no_matching_source_definitions_after_guard" : "ir_no_matching_source_functions",
      rawFunctionCount: rawNames.length,
      sourceDefinitionCount: sourceNameSet.size
    };
  }
  return {
    generated: true,
    names,
    reason: rawNames.length === names.length ? "ir_module_functions" : "ir_module_functions_source_definition_guard",
    irPath,
    rawFunctionCount: rawNames.length,
    sourceDefinitionCount: sourceNameSet.size,
    excludedIrFunctionCount: rawNames.length - names.length,
    guardSource: sourceNameSet.size > 0 ? "source-text-definitions" : null
  };
}

function extractFunctionNamesFromCSource(text) {
  const withoutBlockComments = String(text || "").replace(/\/\*[\s\S]*?\*\//g, " ");
  const names = [];
  const keywords = new Set(["if", "for", "while", "switch", "return", "sizeof"]);
  const lines = withoutBlockComments.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\/\/.*$/, "").trim();
    if (!line || line.startsWith("#") || line.endsWith(";")) continue;
    const signature = line.endsWith(")") && lines[i + 1] && lines[i + 1].trim().startsWith("{")
      ? `${line} {`
      : line;
    if (!signature.includes("(") || !signature.includes(")")) continue;
    const match = signature.match(/^(?:[A-Za-z_][\w:]*\s+|static\s+|inline\s+|extern\s+|const\s+|volatile\s+|signed\s+|unsigned\s+|long\s+|short\s+|struct\s+[A-Za-z_]\w*\s+|enum\s+[A-Za-z_]\w*\s+|\*+\s*)+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/);
    if (!match) continue;
    const name = match[1];
    if (!keywords.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function isCSourcePath(filePath) {
  return /\.c$/i.test(String(filePath || ""));
}

function isCRequest(request) {
  const language = String(request?.language || "").toLowerCase();
  if (language && language !== "c") return false;
  const sourceFiles = Array.isArray(request?.sourceFiles) ? request.sourceFiles : [];
  return language === "c" || sourceFiles.some(isCSourcePath);
}

async function buildSourceTargetFilter(projectRoot, request, options = {}) {
  const sourceFiles = Array.isArray(request?.sourceFiles) ? request.sourceFiles : [];
  const resolvedSourceFiles = [];
  for (const source of sourceFiles) {
    if (!isCSourcePath(source)) continue;
    const sourcePath = path.isAbsolute(source) ? source : path.resolve(projectRoot, source);
    resolvedSourceFiles.push(sourcePath);
  }

  const irPath = options.irPath || request?.ir || (request?.outDir ? path.resolve(projectRoot, request.outDir, "ir.json") : null);
  const sourceNames = await extractFunctionNamesFromSources(resolvedSourceFiles);
  if (irPath && pathExists(irPath)) {
    const irResult = await extractFunctionNamesFromIr(projectRoot, irPath, resolvedSourceFiles, sourceNames);
    if (irResult.generated) {
      return {
        generated: true,
        mode: "source-file-function-regex",
        reason: irResult.reason,
        filterSource: "ir",
        irPath,
        functionCount: irResult.names.length,
        functions: irResult.names,
        rawIrFunctionCount: irResult.rawFunctionCount,
        sourceTextFunctionCount: irResult.sourceDefinitionCount,
        excludedIrFunctionCount: irResult.excludedIrFunctionCount,
        guardSource: irResult.guardSource,
        sourceFiles: resolvedSourceFiles,
        regex: `^(?:${irResult.names.map(escapeRegex).join("|")})$`
      };
    }
  }

  const names = sourceNames;
  if (names.length < 1) {
    return {
      generated: false,
      reason: sourceFiles.length ? "no_source_c_functions_detected" : "no_source_files_provided",
      sourceFiles: resolvedSourceFiles,
      filterSource: "source-text-fallback",
      irPath: irPath || null,
      functionCount: 0,
      functions: [],
      regex: null
    };
  }
  return {
    generated: true,
    mode: "source-file-function-regex",
    reason: "source_c_function_definitions",
    filterSource: "source-text-fallback",
    irPath: irPath || null,
    functionCount: names.length,
    functions: names,
    sourceFiles: resolvedSourceFiles,
    regex: `^(?:${names.map(escapeRegex).join("|")})$`
  };
}

async function maybeConstrainAllFunctionsToSource(projectRoot, request) {
  if (!isCRequest(request)) {
    return { request, context: { generated: false, reason: "non_c_target" } };
  }
  const functions = request.functions || {};
  if (functions.mode && functions.mode !== "all") {
    return { request, context: { generated: false, reason: "function_selection_present" } };
  }
  const filter = await buildSourceTargetFilter(projectRoot, request);
  if (!filter.generated) {
    return { request, context: filter };
  }
  return {
    request: {
      ...request,
      functions: {
        mode: "regex",
        value: filter.regex
      }
    },
    context: filter
  };
}

function normalizeSeverity(value) {
  return ["info", "warning", "error"].includes(value) ? value : "warning";
}

function pushDiagnostic(list, diagnostic) {
  const normalized = {
    severity: normalizeSeverity(diagnostic.severity),
    code: String(diagnostic.code || "unknown"),
    message: String(diagnostic.message || ""),
    source: diagnostic.source || "mcp",
    blocking: Boolean(diagnostic.blocking)
  };
  const key = `${normalized.code}|${normalized.message}`;
  if (!list.some((item) => `${item.code}|${item.message}` === key)) {
    list.push(normalized);
  }
}

function classifyDiagnosticLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const missingHeader = text.match(/fatal error:\s*['"]([^'"]+)['"]\s*file not found/i);
  if (missingHeader) {
    const header = missingHeader[1];
    const systemHeaders = new Set(["stddef.h", "stdint.h", "stdio.h", "stdlib.h", "string.h", "stdbool.h", "limits.h"]);
    return {
      severity: "warning",
      code: systemHeaders.has(header.toLowerCase()) ? "blocked_compile_context" : "blocked_missing_include",
      message: `Local analyzer compile context is incomplete: ${header} was not found.`,
      source: "stderr",
      blocking: true
    };
  }
  const msvcMissing = text.match(/cannot open include file:\s*['"]([^'"]+)['"]/i);
  if (msvcMissing) {
    return {
      severity: "warning",
      code: "blocked_missing_include",
      message: `Local analyzer compile context is incomplete: ${msvcMissing[1]} was not found.`,
      source: "stderr",
      blocking: true
    };
  }
  if (lower.includes("[configloader]") && lower.includes("using defaults")) {
    return null;
  }
  if (lower.includes("no such file") || lower.includes("file not found")) {
    return {
      severity: "warning",
      code: "blocked_compile_context",
      message: text,
      source: "stderr",
      blocking: true
    };
  }
  if (lower.includes("tool not found")) {
    return {
      severity: "error",
      code: "local_tool_missing",
      message: text,
      source: "stderr",
      blocking: true
    };
  }
  return null;
}

function normalizeDiagnostics({ report, stderr, stdout, logText, localToolchain }) {
  const diagnostics = [];
  for (const diagnostic of report?.diagnostics || []) {
    pushDiagnostic(diagnostics, { ...diagnostic, source: diagnostic.source || "cli" });
  }
  for (const rawLine of `${stderr || ""}\n${stdout || ""}\n${logText || ""}`.split(/\r?\n/)) {
    const diagnostic = classifyDiagnosticLine(rawLine);
    if (diagnostic) pushDiagnostic(diagnostics, diagnostic);
  }
  if (report?.status === "coverage_unmet" && !diagnostics.some((item) => item.code === "coverage_not_measured")) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "coverage_not_measured",
      message: "PerfectOne generated artifacts but did not observe target-scoped runtime coverage.",
      source: "mcp",
      blocking: false
    });
  }
  const hasLocalCompileIssue = diagnostics.some((item) =>
    item.code === "blocked_compile_context" || item.code === "blocked_missing_include"
  );
  if (hasLocalCompileIssue) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "local_compile_environment_incomplete",
      message: "Local analyzer/compiler context is incomplete. Generated PerfectOne artifacts may still be useful, and an explicit Docker run can remain valid separately.",
      source: "mcp",
      blocking: true
    });
  }
  const hasCompiler = (localToolchain?.compilers || []).some((item) => item.available);
  if (!hasCompiler) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "local_tool_missing",
      message: "No local C compiler was detected for Coding Platform native coverage fallback.",
      source: "mcp",
      blocking: true
    });
  }
  return diagnostics;
}

function summarizeDiagnostics(diagnostics) {
  const codes = {};
  for (const diagnostic of diagnostics) {
    codes[diagnostic.code] = (codes[diagnostic.code] || 0) + 1;
  }
  return {
    total: diagnostics.length,
    blocking: diagnostics.filter((item) => item.blocking).length,
    codes,
    hasCoverageGap: Boolean(codes.coverage_not_measured),
    hasLocalCompileIssue: Boolean(codes.blocked_compile_context || codes.blocked_missing_include || codes.local_compile_environment_incomplete)
  };
}

function resolveRequestOutDir(projectRoot, request) {
  const raw = request?.outDir || ".perfectone/unit-verify";
  return path.resolve(projectRoot, raw);
}

function artifactPath(artifact) {
  return artifact?.path || artifact?.absolutePath || artifact?.file || null;
}

function symbolFromArtifact(filePath) {
  const base = path.basename(filePath);
  let match = base.match(/^harness_(.+)_(?:native|klee|gtest|cbmc|libfuzzer)\.c$/i);
  if (match) return match[1];
  match = base.match(/^f_(.+)_stubs\.(?:c|h)$/i);
  if (match) return match[1];
  match = base.match(/^f_(.+)\.c$/i);
  if (match) return match[1];
  match = base.match(/^symbol_mapping_(.+)\.json$/i);
  if (match) return match[1];
  return null;
}

function ensureFunctionReport(map, symbol, request, diagnostics) {
  if (!map.has(symbol)) {
    map.set(symbol, {
      symbol,
      file: request?.sourceFiles?.[0] || null,
      language: request?.language || "c",
      perfectOneArtifacts: {
        splitSource: null,
        stubSource: null,
        stubHeader: null,
        harnesses: [],
        coverageArtifacts: []
      },
      codingPlatformActions: [],
      codingPlatformPrompt: "",
      commands: [],
      coverage: { status: "not_measured", line: null, branch: null, mcdc: null },
      diagnostics: diagnostics
        .filter((item) => item.blocking || item.code === "coverage_not_measured")
        .map((item) => ({ severity: item.severity, code: item.code, message: item.message })),
      verdict: "needs_coding_platform_coverage"
    });
  }
  return map.get(symbol);
}

function quoteCommandArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function localCoverageCommandsForFunction(functionReport) {
  const harness = functionReport.perfectOneArtifacts?.harnesses?.[0] || functionReport.harnesses?.[0] || null;
  if (!harness) return [];
  const dir = path.dirname(harness);
  const harnessName = path.basename(harness);
  const exeName = `${slug(functionReport.symbol)}_coverage.exe`;
  const profraw = `${slug(functionReport.symbol)}.profraw`;
  const profdata = `${slug(functionReport.symbol)}.profdata`;
  return [
    `cd ${quoteCommandArg(dir)}`,
    `gcc -std=c11 -O0 -g --coverage -fprofile-arcs -ftest-coverage ${quoteCommandArg(harnessName)} -o ${quoteCommandArg(exeName)}`,
    `${quoteCommandArg(path.join(dir, exeName))} < ${quoteCommandArg("seed-input.txt")}`,
    `gcov -b -c ${quoteCommandArg(harnessName)}`,
    `clang -O0 -g -fprofile-instr-generate -fcoverage-mapping ${quoteCommandArg(harnessName)} -o ${quoteCommandArg(exeName)}`,
    `set LLVM_PROFILE_FILE=${profraw} && ${quoteCommandArg(path.join(dir, exeName))} < ${quoteCommandArg("seed-input.txt")}`,
    `llvm-profdata merge -sparse ${quoteCommandArg(profraw)} -o ${quoteCommandArg(profdata)}`,
    `llvm-cov report ${quoteCommandArg(path.join(dir, exeName))} -instr-profile=${quoteCommandArg(profdata)}`
  ];
}

function functionPrompt(functionReport) {
  const artifacts = functionReport.perfectOneArtifacts || {};
  return [
    `Complete target-scoped unit verification for C function ${functionReport.symbol}.`,
    `Use splitSource=${artifacts.splitSource || "none"}, stubSource=${artifacts.stubSource || "none"}, stubHeader=${artifacts.stubHeader || "none"}, harness=${(artifacts.harnesses || []).join(", ") || "none"}.`,
    "First compile the generated native harness locally. If it fails, inspect the compiler diagnostic and make a local working-copy repair to the generated split/stub/harness or include flags; do not edit user source just to satisfy generated harness compilation.",
    "Then run the harness with explicit seed input, collect gcov or llvm-cov output, and only approve coverage that maps back to this function symbol. If coverage cannot be attributed to the symbol, report target_scope_unverified."
  ].join(" ");
}

function buildFunctionReports(report, request, diagnostics) {
  const map = new Map();
  for (const item of report?.functions || []) {
    const symbol = item?.symbol || item?.target_symbol || item?.name || item?.target || null;
    if (symbol) ensureFunctionReport(map, String(symbol), request, diagnostics);
  }
  const requested = request?.functions;
  if (requested?.mode === "name" && requested.value) {
    ensureFunctionReport(map, String(requested.value), request, diagnostics);
  }
  for (const artifact of report?.artifacts || []) {
    const fullPath = artifactPath(artifact);
    if (!fullPath) continue;
    const symbol = symbolFromArtifact(fullPath);
    if (!symbol) continue;
    const functionReport = ensureFunctionReport(map, symbol, request, diagnostics);
    const lower = path.basename(fullPath).toLowerCase();
    if (/^f_.+_stubs\.c$/i.test(lower)) {
      functionReport.perfectOneArtifacts.stubSource = fullPath;
    } else if (/^f_.+_stubs\.h$/i.test(lower)) {
      functionReport.perfectOneArtifacts.stubHeader = fullPath;
    } else if (/^f_.+\.c$/i.test(lower)) {
      functionReport.perfectOneArtifacts.splitSource = fullPath;
    } else if (/^harness_.+\.c$/i.test(lower)) {
      if (!functionReport.perfectOneArtifacts.harnesses.includes(fullPath)) {
        functionReport.perfectOneArtifacts.harnesses.push(fullPath);
      }
    }
    if (artifact.type === "coverage") {
      functionReport.perfectOneArtifacts.coverageArtifacts.push(fullPath);
    }
  }
  for (const functionReport of map.values()) {
    functionReport.coverage.status = report?.status === "passed" ? "measured" : "not_measured";
    functionReport.coverage.line = report?.coverage?.line ?? null;
    functionReport.coverage.branch = report?.coverage?.branch ?? null;
    functionReport.coverage.mcdc = report?.coverage?.mcdc ?? null;
    if (report?.status === "passed") {
      functionReport.verdict = "passed";
    } else if (diagnostics.some((item) => item.code === "local_compile_environment_incomplete")) {
      functionReport.verdict = "local_environment_blocked";
    }
    functionReport.codingPlatformActions = [
      "Use the generated PerfectOne split, stub, and harness artifacts as the starting point.",
      "Produce candidate-local target-scoped coverage with a local compiler before approving the function."
    ];
    functionReport.commands = localCoverageCommandsForFunction(functionReport);
    functionReport.codingPlatformPrompt = functionPrompt(functionReport);
  }
  return Array.from(map.values());
}

function mergeActions(existing, additions) {
  const result = [];
  for (const item of [...(existing || []), ...additions]) {
    if (item && !result.includes(item)) result.push(item);
  }
  return result;
}

function missingHeadersFromDiagnostics(diagnostics) {
  const headers = [];
  for (const diagnostic of diagnostics || []) {
    const message = String(diagnostic.message || "");
    for (const pattern of [
      /compile context is incomplete:\s*(.+?)\s+was not found/i,
      /fatal error:\s*['"]([^'"]+)['"]\s+file not found/i,
      /cannot open include file:\s*['"]([^'"]+)['"]/i
    ]) {
      const match = message.match(pattern);
      if (match && match[1] && !headers.includes(match[1])) headers.push(match[1]);
    }
  }
  return headers;
}

function findHeaderCandidates(projectRoot, headerName, maxResults = 5) {
  if (!projectRoot || !headerName || !existsSync(projectRoot)) return [];
  const results = [];
  const stack = [projectRoot];
  let visited = 0;
  while (stack.length && results.length < maxResults && visited < 2000) {
    const dir = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
      } else if (entry.name.toLowerCase() === headerName.toLowerCase()) {
        results.push(full);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results;
}

function compileContextHints(projectRoot, diagnostics) {
  const headers = missingHeadersFromDiagnostics(diagnostics);
  return headers.map((header) => {
    const candidates = findHeaderCandidates(projectRoot, header);
    const systemHeader = ["stddef.h", "stdint.h", "stdio.h", "stdlib.h", "string.h", "stdbool.h", "wchar.h", "limits.h"].includes(header.toLowerCase());
    return {
      header,
      classification: systemHeader ? "system-header-context" : "project-header-context",
      candidatePaths: candidates,
      includeDirs: Array.from(new Set(candidates.map((candidate) => path.dirname(candidate)))),
      prompt: candidates.length
        ? `Add one of these include directories for ${header}: ${Array.from(new Set(candidates.map((candidate) => path.dirname(candidate)))).join(", ")}.`
        : systemHeader
          ? `Use the local compiler's system include context for ${header}; if the analyzer still fails, provide compile_commands.json or explicit resource/system include flags.`
          : `Find or create the project include path for ${header}; do not treat this as a source-code defect until compile context is supplied.`
    };
  });
}

function codingPlatformActions(report, diagnostics, localToolchain, compileHints = [], options = {}) {
  const cFlowEnabled = Boolean(options.cFlowEnabled);
  const actions = [];
  if (report?.status === "coverage_unmet" && cFlowEnabled) {
    actions.push("Treat coverage_unmet as artifact generation complete and coverage execution required, not as an MCP tool failure.");
    actions.push("Before coding-agent residual repair, run source-target-filtered KLEE coverage with --func_regex and MCDC enabled, or run the local LLVM MCDC path when Docker is unavailable or explicitly disabled.");
    actions.push("Use coding-agent generated harness or testcase repair only as residual fill for uncovered source-target functions, lines, branches, or MCDC obligations after PerfectOne KLEE coverage.");
  } else if (report?.status === "coverage_unmet") {
    actions.push("This request was not detected as C; do not apply the PerfectOne C filtered KLEE/MC/DC flow. Route non-C work through the appropriate general unit verification workflow.");
  }
  if (diagnostics.some((item) => item.code === "local_compile_environment_incomplete")) {
    actions.push("Repair or supply local compile context, preferably compile_commands.json or explicit include/system include flags.");
    actions.push("Keep Docker success/failure separate from local analyzer context diagnostics.");
  }
  for (const hint of compileHints) {
    actions.push(hint.prompt);
  }
  const gcc = localToolchain?.tools?.find((item) => item.name === "gcc" && item.available);
  const clang = localToolchain?.tools?.find((item) => item.name === "clang" && item.available);
  if (gcc && cFlowEnabled) {
    actions.push("Local GCC/gcov fallback template: gcc -std=c11 -O0 -g --coverage -fprofile-arcs -ftest-coverage <sources> -o <test.exe>, then run and gcov -b -c.");
  }
  if (clang && cFlowEnabled) {
    actions.push("Local Clang MCDC template: clang -O0 -g -fprofile-instr-generate -fcoverage-mapping -fcoverage-mcdc <sources> -o <test.exe>, set LLVM_PROFILE_FILE, then merge with llvm-profdata and report with llvm-cov.");
  }
  return actions;
}

function codingPlatformPrompt({ request, diagnostics, functionReports, compileHints, actions, cFlowEnabled }) {
  const targetFiles = (request?.sourceFiles || []).join(", ") || "unknown";
  const symbols = (functionReports || []).map((item) => item.symbol).join(", ") || "unknown";
  const blocking = (diagnostics || []).filter((item) => item.blocking).map((item) => `${item.code}: ${item.message}`).join(" | ") || "none";
  const hints = (compileHints || []).map((item) => item.prompt).join(" ");
  if (!cFlowEnabled) {
    return [
      "This PerfectOne MCP result was not detected as a C target.",
      `Targets: ${targetFiles}. Functions: ${symbols}.`,
      `Blocking diagnostics: ${blocking}.`,
      "Do not apply the C filtered KLEE/MC/DC workflow to this request. Use the general unit verification workflow for non-C targets."
    ].join(" ");
  }
  return [
    "You are the Coding Platform completing PerfectOne unit verification.",
    `Targets: ${targetFiles}. Functions: ${symbols}.`,
    `Blocking diagnostics: ${blocking}.`,
    hints ? `Compile-context hints: ${hints}` : "",
    "Do not stop at coverage_unmet. Interpret it as PerfectOne split/stub/harness artifact generation complete, then run source-target-filtered KLEE coverage with --func_regex and MCDC enabled before any coding-agent residual repair.",
    "Do not use harness-only coverage as the C final path. Harness-only work is allowed only as residual fill for uncovered functions, branches, or MCDC obligations after filtered KLEE evidence exists.",
    "If Docker is unavailable or the user selects local, use the local LLVM coverage path with -fprofile-instr-generate, -fcoverage-mapping, and -fcoverage-mcdc when the installed clang supports it; otherwise explain why local MCDC is blocked and prefer Docker MCDC.",
    `Recommended actions: ${(actions || []).join(" ")}`
  ].filter(Boolean).join(" ");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slug(value) {
  return String(value || "function").replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "function";
}

function artifactEntry(filePath, outDir, type) {
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(filePath).size;
  } catch {
    sizeBytes = 0;
  }
  return {
    path: path.resolve(filePath),
    relativePath: path.relative(outDir, filePath) || path.basename(filePath),
    type,
    sizeBytes
  };
}

function readSmallTextSync(filePath, max = 4096) {
  if (!filePath || !existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf8").slice(0, max);
  } catch {
    return "";
  }
}

function readJsonSync(filePath) {
  const text = readSmallTextSync(filePath, MAX_OUTPUT);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function walkFilesSync(root, options = {}) {
  if (!root || !existsSync(root)) return [];
  const maxFiles = options.maxFiles ?? 4000;
  const maxDepth = options.maxDepth ?? 8;
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && results.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (depth < maxDepth && !["node_modules", ".git", "html_cov", "coverage_results"].includes(lower)) {
          stack.push({ dir: full, depth: depth + 1 });
        }
      } else {
        results.push(full);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results;
}

function relativeArtifact(filePath, outDir) {
  if (!filePath) return null;
  return {
    path: path.resolve(filePath),
    relativePath: outDir ? path.relative(outDir, filePath) || path.basename(filePath) : path.basename(filePath),
    exists: pathExists(filePath)
  };
}

function parseStatusCode(text) {
  const value = String(text || "").trim();
  const exitMatch = value.match(/exitCode\s*=\s*(-?\d+)/i);
  if (exitMatch) return Number(exitMatch[1]);
  const intMatch = value.match(/^-?\d+$/);
  return intMatch ? Number(intMatch[0]) : null;
}

function classifyRuntimeFailure(exitCode, logText) {
  const lower = String(logText || "").toLowerCase();
  if (exitCode === 139 || lower.includes("segmentation fault") || lower.includes("segfault")) return "segfault";
  if (exitCode === 136 || lower.includes("floating point exception")) return "floating_point_exception";
  if (exitCode === 134 || lower.includes("abort")) return "abort";
  if (exitCode === 124 || lower.includes("timed out") || lower.includes("timeout")) return "timeout";
  if (exitCode !== null && exitCode !== 0) return "nonzero_exit";
  return "runtime_failure";
}

function parseInputPreview(inputPath) {
  const raw = readSmallTextSync(inputPath, 2048).trim();
  if (!raw) return { format: "missing", preview: "", values: [] };
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const keyValues = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.\[\]-]*)\s*[:=]\s*(.+)$/);
    if (match) keyValues.push({ name: match[1], value: match[2] });
  }
  if (keyValues.length > 0) {
    return { format: "key-value", preview: keyValues.slice(0, 24).map((item) => `${item.name}=${item.value}`).join(", "), values: keyValues.slice(0, 64), truncated: keyValues.length > 64 };
  }
  const tokens = raw.split(/\s+/).filter(Boolean);
  return {
    format: "scalar-sequence",
    preview: tokens.slice(0, 64).join(" "),
    values: tokens.slice(0, 128),
    truncated: tokens.length > 128
  };
}

function parseXmlInputPreview(xmlPath) {
  const xml = readSmallTextSync(xmlPath, 8192);
  if (!xml) return null;
  const values = [];
  const pattern = /<input\b[^>]*\bvariable\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/input>/gi;
  let match;
  while ((match = pattern.exec(xml)) && values.length < 64) {
    values.push({ name: match[1], value: match[2].replace(/<[^>]+>/g, "").trim() });
  }
  if (!values.length) return null;
  return {
    format: "xml-inputs",
    preview: values.slice(0, 24).map((item) => `${item.name}=${item.value}`).join(", "),
    values,
    truncated: Boolean(pattern.exec(xml))
  };
}

function inferFunctionAndCase(filePath, outDir) {
  const rel = String(outDir ? path.relative(outDir, filePath) : filePath).replace(/\\/g, "/");
  const parts = rel.split("/");
  let func = parts[0] || null;
  if ([".", ".perfectone", "mcp_reports", "coverage_results", "html_cov"].includes(String(func).toLowerCase())) func = null;
  let testcaseId = null;
  for (const part of parts) {
    let match = part.match(/^(?:temp_run_|temp_cbmc_)?(test\d+|input_test_cbmc_[A-Za-z0-9_.-]+)/i);
    if (match) testcaseId = match[1];
    match = part.match(/^(test\d+)\./i);
    if (match) testcaseId = match[1];
  }
  return { function: func, testcaseId };
}

function siblingInputFor(filePath, testcaseId) {
  const dir = path.dirname(filePath);
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const preferred = files.find((name) => /^input_.+\.txt$/i.test(name) && (!testcaseId || name.toLowerCase().includes(testcaseId.toLowerCase())));
  return preferred ? path.join(dir, preferred) : null;
}

function xmlOrKtestFor(kleeErrPath, testcaseId) {
  const dir = path.dirname(kleeErrPath);
  const base = testcaseId || path.basename(kleeErrPath).split(".")[0];
  const xml = path.join(dir, `${base}.xml`);
  const ktest = path.join(dir, `${base}.ktest`);
  return { xml: pathExists(xml) ? xml : null, ktest: pathExists(ktest) ? ktest : null };
}

function replayDescriptor({ projectRoot, outDir, cliPath, func, tool = "klee" }) {
  const args = { projectRoot, outDir };
  if (func) args.func = func;
  if (tool) args.tool = tool;
  const cliArgs = ["--phase", "replay", "--outdir", outDir];
  if (func) cliArgs.push("--func", func);
  if (tool) cliArgs.push("--tool", tool);
  return {
    mcpTool: "perfectone_replay",
    arguments: args,
    cliCommand: cliPath ? `${quoteCommandArg(cliPath)} ${cliArgs.map(quoteCommandArg).join(" ")}` : null
  };
}

function collectExpectedMismatchEvidence({ projectRoot, outDir, cliPath }) {
  const candidates = new Set();
  for (const base of [
    outDir,
    path.join(outDir || "", "unit-design"),
    path.join(projectRoot || "", ".perfectone", "unit-design")
  ]) {
    if (!base || !existsSync(base)) continue;
    for (const file of walkFilesSync(base, { maxFiles: 300, maxDepth: 3 })) {
      const name = path.basename(file).toLowerCase();
      if (name.endsWith(".json") && (name.includes("expected") || name.includes("comparison") || name.includes("oracle"))) {
        candidates.add(file);
      }
    }
  }
  const cases = [];
  for (const file of candidates) {
    const artifact = readJsonSync(file);
    if (!artifact || artifact.schemaVersion !== "unitverify.expected-comparison.v1") continue;
    for (const row of artifact.results || []) {
      if (!["mismatch", "missing_actual"].includes(row.status)) continue;
      const checks = Array.isArray(row.checks) ? row.checks.filter((item) => !item.passed) : [];
      cases.push({
        type: "spec_mismatch",
        severity: "error",
        function: row.unitId || row.function || null,
        testcaseId: row.testcaseId || row.caseId || row.oracleId || null,
        oracleId: row.oracleId || null,
        status: row.status,
        input: row.input ?? row.inputs ?? null,
        expected: row.expected ?? (checks.length ? Object.fromEntries(checks.map((item) => [item.field || "value", item.expected])) : null),
        actual: row.actual ?? (checks.length ? Object.fromEntries(checks.map((item) => [item.field || "value", item.actual])) : null),
        checks,
        message: row.status === "missing_actual" ? "Expected-value check has no actual execution result." : "Actual result does not match the expected oracle.",
        artifacts: { comparison: relativeArtifact(file, outDir) },
        replay: replayDescriptor({ projectRoot, outDir, cliPath, func: row.unitId || row.function || null, tool: "klee" })
      });
    }
  }
  return cases;
}

function collectFailureEvidence({ projectRoot, outDir, cliPath }) {
  const cases = [];
  const files = walkFilesSync(outDir, { maxFiles: 6000, maxDepth: 8 });
  const seen = new Set();
  for (const file of files) {
    const name = path.basename(file);
    const lower = name.toLowerCase();
    if (lower === "native_run.status") {
      const statusText = readSmallTextSync(file, 256);
      const exitCode = parseStatusCode(statusText);
      if (exitCode === null || exitCode === 0) continue;
      const logPath = path.join(path.dirname(file), "native_run.log");
      const inputPath = siblingInputFor(file, null);
      const context = inferFunctionAndCase(file, outDir);
      const classification = classifyRuntimeFailure(exitCode, readSmallTextSync(logPath, 2048));
      const key = `runtime:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({
        type: classification === "segfault" ? "segfault" : "runtime_crash",
        severity: "error",
        function: context.function,
        testcaseId: context.testcaseId,
        exitCode,
        status: classification,
        input: inputPath ? parseInputPreview(inputPath) : null,
        expected: "No crash and behavior matching the selected oracle/specification.",
        actual: `native replay exited with ${exitCode}`,
        message: truncate(readSmallTextSync(logPath, 2048), 1000) || `native replay exited with ${exitCode}`,
        artifacts: {
          status: relativeArtifact(file, outDir),
          log: relativeArtifact(logPath, outDir),
          input: relativeArtifact(inputPath, outDir)
        },
        replay: replayDescriptor({ projectRoot, outDir, cliPath, func: context.function, tool: "klee" })
      });
    } else if (/\.err$/i.test(lower)) {
      const context = inferFunctionAndCase(file, outDir);
      const { xml, ktest } = xmlOrKtestFor(file, context.testcaseId);
      const errText = readSmallTextSync(file, 2048);
      const classification = /segmentation fault|segfault/i.test(errText) ? "segfault" : `klee_${lower.replace(/^.*\.([^.]+)\.err$/i, "$1")}_error`;
      const key = `klee:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({
        type: classification === "segfault" ? "segfault" : "klee_error",
        severity: "error",
        function: context.function,
        testcaseId: context.testcaseId,
        status: classification,
        input: xml ? parseXmlInputPreview(xml) : null,
        expected: "No symbolic execution error for this path unless the specification marks it as invalid.",
        actual: truncate(errText, 1000) || name,
        message: truncate(errText, 1000) || name,
        artifacts: {
          error: relativeArtifact(file, outDir),
          xml: relativeArtifact(xml, outDir),
          ktest: relativeArtifact(ktest, outDir)
        },
        replay: replayDescriptor({ projectRoot, outDir, cliPath, func: context.function, tool: "klee" })
      });
    }
  }
  cases.push(...collectExpectedMismatchEvidence({ projectRoot, outDir, cliPath }));
  const summary = {
    total: cases.length,
    segfaults: cases.filter((item) => item.type === "segfault").length,
    runtimeCrashes: cases.filter((item) => item.type === "runtime_crash").length,
    kleeErrors: cases.filter((item) => item.type === "klee_error").length,
    expectedMismatches: cases.filter((item) => item.type === "spec_mismatch").length,
    replayAvailable: cases.filter((item) => item.replay?.mcpTool).length
  };
  return {
    schemaVersion: "unitverify.failure-evidence.v1",
    summary,
    replay: replayDescriptor({ projectRoot, outDir, cliPath, tool: "klee" }),
    cases
  };
}

function renderValue(value) {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderArtifactSummary(artifacts) {
  if (!artifacts || typeof artifacts !== "object") return "none";
  const entries = Object.entries(artifacts)
    .filter(([, artifact]) => artifact && artifact.path)
    .map(([name, artifact]) => `${name}: ${artifact.relativePath || artifact.path}${artifact.exists === false ? " (missing)" : ""}`);
  return entries.length ? entries.join("; ") : "none";
}

function reportWithoutTokenUsage(report) {
  const copy = { ...report };
  delete copy.tokenUsage;
  return copy;
}

function enrichManifestArtifacts(artifacts, outDir) {
  return (artifacts || []).map((artifact) => {
    const filePath = artifactPath(artifact);
    const absolutePath = filePath ? path.resolve(filePath) : artifact.path;
    const relativePath = artifact.relativePath || (absolutePath ? path.relative(outDir, absolutePath) : "");
    const normalizedRelative = String(relativePath).replace(/\\/g, "/");
    let type = artifact.type || "artifact";
    if (/^mcp_reports\/functions\/.+\.json$/i.test(normalizedRelative)) {
      type = "function-report";
    } else if (/^mcp_reports\/perfectone_mcp_report\.(?:json|md|html)$/i.test(normalizedRelative)) {
      type = "aggregate-report";
    } else if (/diagnostic/i.test(normalizedRelative)) {
      type = "diagnostic";
    } else if (/commands?\/.+\.(?:cmd|bat|ps1|sh)$/i.test(normalizedRelative)) {
      type = "local-command";
    }
    return {
      ...artifact,
      path: absolutePath,
      relativePath,
      type
    };
  });
}

function parseLcovSummary(text) {
  const totals = {
    line: { total: 0, hit: 0, pct: null },
    branch: { total: 0, hit: 0, pct: null },
    function: { total: 0, hit: 0, pct: null },
    mcdc: { total: 0, hit: 0, pct: null },
    mcdcRecords: 0
  };
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(LF|LH|BRF|BRH|FNF|FNH|MCF|MCH):(\d+)/);
    if (match) {
      const value = Number(match[2]);
      if (match[1] === "LF") totals.line.total += value;
      if (match[1] === "LH") totals.line.hit += value;
      if (match[1] === "BRF") totals.branch.total += value;
      if (match[1] === "BRH") totals.branch.hit += value;
      if (match[1] === "FNF") totals.function.total += value;
      if (match[1] === "FNH") totals.function.hit += value;
      if (match[1] === "MCF") totals.mcdc.total += value;
      if (match[1] === "MCH") totals.mcdc.hit += value;
      continue;
    }
    if (line.startsWith("MCDC:")) totals.mcdcRecords += 1;
  }
  for (const key of ["line", "branch", "function", "mcdc"]) {
    const item = totals[key];
    item.pct = item.total > 0 ? Number(((item.hit / item.total) * 100).toFixed(2)) : null;
  }
  return totals;
}

async function coverageArtifactsForOutDir(outDir) {
  const lcovPath = path.join(outDir, "coverage_input_file.info");
  const manifestPath = path.join(outDir, "coverage_manifest.json");
  const htmlIndexPath = path.join(outDir, "html_cov", "input_file", "index.html");
  const summaryHtmlPath = path.join(outDir, "coverage_summary.html");
  const lcovText = await readTextIfExists(lcovPath);
  let manifest = null;
  const manifestText = await readTextIfExists(manifestPath);
  if (manifestText) {
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      manifest = null;
    }
  }
  const runnerName = String(manifest?.runner || manifest?.execution_mode || "docker");
  const aggregateLogCandidates = [
    path.join(outDir, ".perfectone", "runner_logs", runnerName, "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "docker", "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "local", "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "wsl", "coverage_aggregate.log")
  ];
  const aggregateLogPath = aggregateLogCandidates.find((candidate) => pathExists(candidate)) || aggregateLogCandidates[0];
  const aggregateLogText = await readTextIfExists(aggregateLogPath);
  return {
    lcov: { path: lcovPath, exists: pathExists(lcovPath) },
    manifest: { path: manifestPath, exists: pathExists(manifestPath), data: manifest },
    aggregateLog: { path: aggregateLogPath, exists: pathExists(aggregateLogPath), text: aggregateLogText },
    html: { path: htmlIndexPath, exists: pathExists(htmlIndexPath) },
    summaryHtml: { path: summaryHtmlPath, exists: pathExists(summaryHtmlPath) },
    coverage: lcovText ? parseLcovSummary(lcovText) : null
  };
}

function coverageAggregationDiagnostics(artifacts, executionMode = "unknown") {
  const diagnostics = [];
  const manifest = artifacts?.manifest?.data || null;
  const aggregateLog = String(artifacts?.aggregateLog?.text || "");
  if (!manifest && !aggregateLog) return diagnostics;
  const lcovMissing = !artifacts?.lcov?.exists;
  const failedMessage = /failed to aggregate coverage/i.test(String(manifest?.message || ""));
  const pipelineExitCode = Number(manifest?.pipeline_exit_code ?? 0);
  if (lcovMissing && (failedMessage || pipelineExitCode !== 0 || aggregateLog)) {
    diagnostics.push({
      severity: "error",
      code: "coverage_aggregation_failed",
      message: manifest?.message || `Coverage aggregation failed for ${executionMode}; LCOV output was not produced.`,
      source: "coverage_manifest",
      blocking: true
    });
  }
  if (/No per-function coverage info files found/i.test(aggregateLog)) {
    diagnostics.push({
      severity: "error",
      code: "coverage_aggregation_no_per_function_info",
      message: "Coverage aggregation could not find per-function coverage info files. KLEE/native replay may have run, but no usable LLVM coverage info was emitted for merge.",
      source: "coverage_aggregate.log",
      blocking: true
    });
  }
  const files = manifest?.files || {};
  const mergedProfdata = files.merged_profdata;
  const coverageInput = files.coverage_input_file_info;
  if (lcovMissing && mergedProfdata && mergedProfdata.exists === false) {
    diagnostics.push({
      severity: "error",
      code: "coverage_profdata_missing",
      message: "LLVM profraw/profdata merge output is missing; MC/DC and LCOV cannot be measured from this PerfectOne run.",
      source: "coverage_manifest",
      blocking: true
    });
  }
  if (lcovMissing && coverageInput && coverageInput.exists === false) {
    diagnostics.push({
      severity: "error",
      code: "coverage_lcov_missing",
      message: "coverage_input_file.info was not generated, so final line/branch/function/MC/DC aggregation is unavailable.",
      source: "coverage_manifest",
      blocking: true
    });
  }
  return diagnostics;
}

async function preserveCoverageArtifactsBeforeRun(outDir, executionMode, runId) {
  const candidates = [
    "coverage_manifest.json",
    "coverage_input_file.info",
    "coverage_summary.html"
  ];
  const existing = candidates
    .map((name) => path.join(outDir, name))
    .filter((filePath) => pathExists(filePath));
  if (existing.length === 0) return null;
  const snapshotDir = path.join(outDir, "mcp_reports", "coverage_attempts", `${slug(runId)}_${slug(executionMode || "unknown")}_before`);
  await mkdir(snapshotDir, { recursive: true });
  const files = [];
  for (const filePath of existing) {
    const targetPath = path.join(snapshotDir, path.basename(filePath));
    await copyFile(filePath, targetPath);
    files.push(artifactEntry(targetPath, outDir, "coverage-attempt-snapshot"));
  }
  const dockerLogDir = path.join(outDir, ".perfectone", "docker_logs");
  if (pathExists(dockerLogDir)) {
    const targetLogDir = path.join(snapshotDir, "docker_logs");
    await mkdir(targetLogDir, { recursive: true });
    for (const entry of await readdir(dockerLogDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const sourceLog = path.join(dockerLogDir, entry.name);
      const targetLog = path.join(targetLogDir, entry.name);
      await copyFile(sourceLog, targetLog);
      files.push(artifactEntry(targetLog, outDir, "coverage-attempt-snapshot"));
    }
  }
  return {
    status: "preserved",
    reason: "pre_existing_coverage_artifacts_preserved_before_followup_coverage_run",
    executionMode,
    snapshotDir,
    files
  };
}

function sourceTargetsMissingFromFunctionReports(targetFunctionFilter, functionReports) {
  if (!Array.isArray(functionReports) || functionReports.length === 0) {
    return [];
  }
  const reported = new Set((functionReports || []).map((item) => item.symbol).filter(Boolean));
  return (targetFunctionFilter?.functions || []).filter((name) => !reported.has(name));
}

const C_RESIDUAL_MAX_ATTEMPTS = 5;
const C_RESIDUAL_NO_IMPROVEMENT_LIMIT = 1;
const C_STRUCT_DEPTH_SECURITY_MAX = 5;
const C_COVERAGE_GOAL_PERCENT = 100;
const CODING_AGENT_CODE_AUGMENTATION_METHODS = [
  {
    designMethod: "coverage_growth",
    executionCategory: "coverage-growth",
    required: "always",
    designReason: "Increase uncovered function, line, branch, or MC/DC obligations after the baseline coverage run."
  },
  {
    designMethod: "boundary_value",
    executionCategory: "boundary-value",
    required: "always",
    designReason: "Exercise min, max, just-below, just-above, nominal, and invalid values inferred from comparisons, ranges, and type limits."
  },
  {
    designMethod: "equivalence_partition",
    executionCategory: "equivalence-partition",
    required: "always",
    designReason: "Exercise representative valid and invalid classes inferred from guards, enums, nullability, ranges, and formats."
  },
  {
    designMethod: "undefined_behavior_corner",
    executionCategory: "ub-corner-case",
    required: "conditional",
    designReason: "Run only when code review finds plausible undefined behavior such as null or invalid pointers, bounds errors, signed overflow, divide-by-zero, uninitialized reads, invalid states, or size mismatches."
  },
  {
    designMethod: "abnormal_behavior_corner",
    executionCategory: "abnormal-behavior-corner-case",
    required: "conditional",
    designReason: "Run only when code review or specification review finds plausible abnormal behavior such as invalid mode/state, error return, exception, timeout, resource exhaustion, or unsupported input format."
  }
];
const CODING_AGENT_SPEC_AUGMENTATION_METHODS = [
  {
    designMethod: "decision_table",
    executionCategory: "spec-decision-table",
    required: "review",
    designReason: "Apply when requirements define combinations of conditions, actions, or business rules."
  },
  {
    designMethod: "state_coverage",
    executionCategory: "spec-state-transition",
    required: "review",
    designReason: "Apply when requirements define states, events, transitions, guards, or invalid transitions."
  },
  {
    designMethod: "boundary_value",
    executionCategory: "spec-boundary-value",
    required: "review",
    designReason: "Apply when requirements define numeric, length, date/time, enum-order, or resource limits."
  },
  {
    designMethod: "equivalence_partition",
    executionCategory: "spec-equivalence-partition",
    required: "review",
    designReason: "Apply when requirements define valid and invalid input classes, modes, formats, roles, or state classes."
  }
];

function metricPct(metric) {
  return typeof metric?.pct === "number" ? metric.pct : null;
}

function coverageIncrease(after, before) {
  if (typeof after !== "number" || typeof before !== "number") return null;
  return Number((after - before).toFixed(2));
}

function coverageCumulativeFromPerfectOne(coverage) {
  const perfectOne = {
    line: metricPct(coverage?.line),
    branch: metricPct(coverage?.branch),
    function: metricPct(coverage?.function),
    mcdc: metricPct(coverage?.mcdc)
  };
  const codingAgentAppliedCumulative = {
      status: "pending",
      line: null,
      branch: null,
      function: null,
      mcdc: null
    };
  const codingAgentIncrease = {
      status: "pending",
      line: null,
      branch: null,
      function: null,
      mcdc: null,
      display: {
        line: "+pending",
        branch: "+pending",
        function: "+pending",
        mcdc: "+pending"
      }
    };
  return {
    perfectOne,
    codingAgentAppliedCumulative,
    codingAgentIncrease
  };
}

function coverageMetricStatus(metric, goal = C_COVERAGE_GOAL_PERCENT) {
  if (!metric || typeof metric.pct !== "number") return null;
  if (typeof metric.total === "number" && metric.total === 0) return null;
  return {
    pct: metric.pct,
    covered: metric.covered ?? metric.hit ?? null,
    total: metric.total ?? null,
    goal,
    unmet: metric.pct < goal
  };
}

function coverageUnmetMetrics(coverage, goal = C_COVERAGE_GOAL_PERCENT) {
  const metrics = {};
  for (const name of ["line", "branch", "function", "mcdc"]) {
    const status = coverageMetricStatus(coverage?.[name], goal);
    if (status?.unmet) metrics[name] = status;
  }
  return metrics;
}

function coverageHasUnmet(coverage, goal = C_COVERAGE_GOAL_PERCENT) {
  return Object.keys(coverageUnmetMetrics(coverage, goal)).length > 0;
}

function buildCodingAgentTestAugmentationPlan({ language = "unknown", sourceFiles = [], hasSpecification = false, baselineKind = "native", baselineReady = false, coverageExecution = null, residualTargets = [] } = {}) {
  const codeMethods = CODING_AGENT_CODE_AUGMENTATION_METHODS.map((item) => ({
    ...item,
    status: item.required === "conditional" ? "review_required" : "required",
    executionRequired: item.required !== "conditional",
    reportRequirement: item.required === "conditional"
      ? "If generated and executed, report the UB/error type, triggering input, root-cause analysis, replay command, and artifact/log paths. If not generated, report not_applicable or not_generated with a source-review reason."
      : "Generate, execute, and report testcase inputs, oracle/expected value when available, actual result, coverage impact, replay command, and artifact path."
  }));
  const specMethods = CODING_AGENT_SPEC_AUGMENTATION_METHODS.map((item) => ({
    ...item,
    status: hasSpecification ? "required_review" : "not_applicable_without_specification",
    executionRequired: hasSpecification,
    reportRequirement: hasSpecification
      ? "Generate manual testcase artifacts, execute them in the language-specific workflow, and record the technique application reason in the final report."
      : "Keep the technique available, but do not block execution when no specification or accessible specification link was provided."
  }));
  const executionRequired = Boolean(baselineReady);
  return {
    schemaVersion: "unitverify.coding-agent-test-augmentation-plan.v1",
    owner: "Coding Agent",
    language,
    baselineKind,
    baselineReady,
    executionRequired,
    sourceFiles,
    hasSpecification,
    placement: language === "c"
      ? "after PerfectOne filtered KLEE/MC/DC baseline and before final C report"
      : "after native language test/coverage baseline and before final report",
    codeOnlyDefault: {
      alwaysExecute: ["coverage_growth", "boundary_value", "equivalence_partition"],
      conditionalExecute: ["undefined_behavior_corner"],
      methods: codeMethods
    },
    specificationDriven: {
      requiredWhenSpecificationProvided: ["decision_table", "state_coverage", "boundary_value", "equivalence_partition"],
      methods: specMethods
    },
    residualIntegration: {
      residualTargetCount: (residualTargets || []).length,
      coverageGrowthUsesResidualTargets: true,
      coverageGrowthIsNotLimitedToMissingFunctions: true
    },
    requiredReportFields: [
      "baseline coverage",
      "Coding Agent Applied Cumulative coverage",
      "Coding Agent Increase +N%",
      "testcase design method",
      "technique application reason",
      "input values",
      "expected/oracle",
      "actual result",
      "pass/fail/mismatch classification",
      "replay command",
      "artifact/log path",
      "UB error type and root-cause analysis when UB is generated or observed"
    ],
    instructions: executionRequired ? [
      "Generate and execute coverage-growth testcases after the baseline coverage run.",
      "Generate and execute boundary-value testcases even when only source code was provided.",
      "Generate and execute equivalence-partition testcases even when only source code was provided.",
      "Review the source for UB corner-case risks; generate and execute UB corner testcases only when a plausible risk exists, otherwise report not_applicable or not_generated with the review reason.",
      "When a specification or specification link is provided, generate and execute decision-table, state-transition, boundary-value, and equivalence-partition manual testcases where applicable, and record the reason each technique was applied or not applicable."
    ] : []
  };
}

function buildCodingAgentTestAugmentationPrompt(plan) {
  if (!plan?.executionRequired) {
    return "Coding Agent test augmentation is not ready because the baseline coverage stage has not completed.";
  }
  const specText = plan.hasSpecification
    ? "Specification-driven decision table, state transition, boundary value, and equivalence partition tests must also be generated, executed, and justified in the report."
    : "No specification was provided; keep specification-driven techniques marked not_applicable and proceed with code-derived augmentation.";
  return [
    "Coding Agent test augmentation is required before the final answer.",
    "Always generate and execute coverage-growth, boundary-value, and equivalence-partition testcases from the target code.",
    "Review for UB corner cases such as null or invalid pointers, out-of-bounds access, signed overflow, divide-by-zero, uninitialized reads, invalid states, or buffer-size mismatches; execute UB tests only when a plausible risk exists and report the error type and root cause if triggered.",
    specText,
    "The final HTML report must show baseline coverage, Coding Agent Applied Cumulative coverage, Coding Agent Increase +N%, testcase inputs, expected/oracle values, actual results, replay commands, artifact paths, and technique application reasons."
  ].join(" ");
}

function buildCodingAgentTestAugmentationActionRequired(plan) {
  if (!plan?.executionRequired) {
    return {
      required: false,
      completionBlocked: false,
      finalAnswerAllowed: true,
      nextRequiredAction: null,
      message: "Coding Agent test augmentation is not required yet."
    };
  }
  return {
    required: true,
    completionBlocked: true,
    finalAnswerAllowed: false,
    nextRequiredAction: "execute_coding_agent_test_augmentation",
    owner: "Active Coding Agent",
    reason: "Baseline coverage is complete, but required Coding Agent coverage-growth, boundary-value, equivalence-partition, and conditional UB testcase augmentation has not been executed.",
    codeOnlyAlwaysExecute: ["coverage_growth", "boundary_value", "equivalence_partition"],
    conditionalExecute: ["undefined_behavior_corner"],
    specificationDrivenRequiredWhenProvided: ["decision_table", "state_coverage", "boundary_value", "equivalence_partition"],
    requiredEvidence: [
      "testcase design method",
      "technique application reason",
      "input values",
      "expected/oracle values",
      "actual results",
      "pass/fail/mismatch classification",
      "replay command",
      "artifact/log path",
      "coverage before/after and cumulative +increase",
      "UB error type and root-cause analysis when applicable"
    ],
    prohibitedShortcuts: [
      "Do not stop with only the baseline coverage summary.",
      "Do not skip boundary-value or equivalence-partition testcases when only source code was provided.",
      "Do not mark UB as executed when source review found no plausible UB risk; report not_applicable or not_generated with the review reason instead.",
      "Do not leave Coding Agent Applied Cumulative coverage as pending in the final report."
    ],
    message: buildCodingAgentTestAugmentationPrompt(plan)
  };
}

function normalizeFunctionNameFromCoveragePath(filePath) {
  const base = path.basename(String(filePath || ""), path.extname(String(filePath || "")));
  return base
    .replace(/^f_/, "")
    .replace(/^harness_/, "")
    .replace(/_(native|klee|cbmc|fuzz|coverage|test|gcov|llvm)$/i, "");
}

async function buildPerFunctionCoverageTargets(outDir, targetFunctionFilter, coverage, goal = C_COVERAGE_GOAL_PERCENT) {
  const sourceTargets = targetFunctionFilter?.functions || [];
  const residualByFunction = new Map();
  const observed = new Set();
  const addResidual = (name, details = {}) => {
    if (!name || residualByFunction.has(name)) return;
    residualByFunction.set(name, {
      function: name,
      source: details.source || "coverage",
      reason: details.reason || "coverage_below_goal",
      coverage: details.coverage || null,
      unmetMetrics: details.unmetMetrics || coverageUnmetMetrics(details.coverage, goal),
      goal
    });
  };

  if (coverageHasUnmet(coverage, goal)) {
    // Aggregate coverage below 100% is a signal for coding-agent residual fill, but
    // residual work must still be assigned per source-target function below.
  }

  for (const functionName of sourceTargets) {
    const functionDir = path.join(outDir, functionName);
    if (!pathExists(functionDir)) continue;
    const files = await readdir(functionDir).catch(() => []);
    const jsonFiles = files.filter((name) => /^cov_.*_llvm\.json$/i.test(name));
    for (const jsonName of jsonFiles) {
      const jsonPath = path.join(functionDir, jsonName);
      const text = await readTextIfExists(jsonPath);
      if (!text) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      for (const data of parsed?.data || []) {
        for (const file of data?.files || []) {
          const normalized = normalizeFunctionNameFromCoveragePath(file.filename);
          const matchedFunction = sourceTargets.includes(normalized) ? normalized : functionName;
          if (!sourceTargets.includes(matchedFunction)) continue;
          observed.add(matchedFunction);
          const fileCoverage = {
            line: file.summary?.lines
              ? { pct: file.summary.lines.percent, covered: file.summary.lines.covered, total: file.summary.lines.count }
              : null,
            branch: file.summary?.branches
              ? { pct: file.summary.branches.percent, covered: file.summary.branches.covered, total: file.summary.branches.count }
              : null,
            function: file.summary?.functions
              ? { pct: file.summary.functions.percent, covered: file.summary.functions.covered, total: file.summary.functions.count }
              : null,
            mcdc: file.summary?.mcdc
              ? { pct: file.summary.mcdc.percent, covered: file.summary.mcdc.covered, total: file.summary.mcdc.count }
              : null
          };
          if (coverageHasUnmet(fileCoverage, goal)) {
            addResidual(matchedFunction, {
              source: jsonPath,
              reason: "per_function_coverage_below_goal",
              coverage: fileCoverage
            });
          }
        }
        for (const fn of data?.functions || []) {
          const name = fn.name || fn.demangled_name || functionName;
          if (!sourceTargets.includes(name)) continue;
          observed.add(name);
          const functionCoverage = {
            line: fn.summary?.lines
              ? { pct: fn.summary.lines.percent, covered: fn.summary.lines.covered, total: fn.summary.lines.count }
              : null,
            branch: fn.summary?.branches
              ? { pct: fn.summary.branches.percent, covered: fn.summary.branches.covered, total: fn.summary.branches.count }
              : null,
            function: fn.summary?.functions
              ? { pct: fn.summary.functions.percent, covered: fn.summary.functions.covered, total: fn.summary.functions.count }
              : { pct: 100, covered: 1, total: 1 },
            mcdc: fn.summary?.mcdc
              ? { pct: fn.summary.mcdc.percent, covered: fn.summary.mcdc.covered, total: fn.summary.mcdc.count }
              : null
          };
          if (coverageHasUnmet(functionCoverage, goal)) {
            addResidual(name, {
              source: jsonPath,
              reason: "per_function_coverage_below_goal",
              coverage: functionCoverage
            });
          }
        }
      }
    }
  }

  for (const functionName of sourceTargets) {
    if (!observed.has(functionName)) {
      addResidual(functionName, {
        source: "coverage-discovery",
        reason: "not_observed_in_per_function_coverage",
        coverage: {
          function: { pct: 0, covered: 0, total: 1 }
        }
      });
    }
  }

  if (residualByFunction.size === 0 && coverageHasUnmet(coverage, goal)) {
    for (const functionName of sourceTargets) {
      addResidual(functionName, {
        source: "aggregate-coverage",
        reason: "aggregate_coverage_below_goal_per_function_detail_unavailable",
        coverage
      });
    }
  }

  return [...residualByFunction.values()];
}

function codingAgentResidualLoopForFunction(item) {
  const details = typeof item === "string" ? { function: item } : (item || {});
  return {
    function: details.function,
    source: details.source || null,
    reason: details.reason || "coverage_below_goal",
    coverage: details.coverage || null,
    unmetMetrics: details.unmetMetrics || coverageUnmetMetrics(details.coverage, details.goal || C_COVERAGE_GOAL_PERCENT),
    goal: details.goal || C_COVERAGE_GOAL_PERCENT,
    residualLoop: {
      mode: "per-function-coverage-growth-loop",
      maxAttempts: C_RESIDUAL_MAX_ATTEMPTS,
      noImprovementLimit: C_RESIDUAL_NO_IMPROVEMENT_LIMIT,
      continuationRule: "if a coding-agent residual attempt increases any requested coverage metric and the 100% goal is still unmet, the next attempt is mandatory until maxAttempts is reached or a later attempt has no coverage increase",
      attemptHistory: [],
      bestCoverage: details.coverage || null,
      stopRule: `run Coding Agent residual repair up to ${C_RESIDUAL_MAX_ATTEMPTS} attempts. Each attempt must directly edit generated verification artifacts, then replay and remeasure coverage. A coverage-increasing attempt cannot be the last attempt unless the 100% goal is reached. Stop before attempt ${C_RESIDUAL_MAX_ATTEMPTS} only when the 100% goal is reached, or when a coding-agent attempt shows no coverage increase and the remaining gap is classified with evidence as max-coverage, infeasible, crash-risk, or toolchain-blocked`,
      stopReason: null
    }
  };
}

function buildCodingAgentResidualRepairPlan({ residualTargets, targetFunctionFilter, coverageExecution }) {
  const targets = (residualTargets || []).map((item) => ({
    function: item.function,
    reason: item.reason || "coverage_below_goal",
    goal: item.goal || C_COVERAGE_GOAL_PERCENT,
    maxAttempts: C_RESIDUAL_MAX_ATTEMPTS,
    earlyStopNoImprovementAttempts: C_RESIDUAL_NO_IMPROVEMENT_LIMIT,
    unmetMetrics: Object.keys(item.unmetMetrics || {}),
    currentCoverage: item.coverage || null,
    evidenceSource: item.source || null,
    attemptHistoryRequired: true
  }));
  return {
    schemaVersion: "unitverify.coding-agent-residual-repair-plan.v1",
    executionRequired: targets.length > 0,
    owner: "Coding Agent",
    targetSourceFiles: targetFunctionFilter?.sourceFiles || [],
    functionRegex: targetFunctionFilter?.regex || null,
    baseline: {
      executionMode: coverageExecution?.executionMode || "unknown",
      runner: coverageExecution?.runner || "unknown",
      kleeExecuted: Boolean(coverageExecution?.klee?.executed),
      mcdcMeasured: Boolean(coverageExecution?.mcdc?.measured),
      coverage: coverageExecution?.coverage || null
    },
    residualMcdcStrategy: coverageExecution?.residualMcdcStrategy || null,
    executionStrategy: {
      first: coverageExecution?.residualMcdcStrategy?.defaultPath || "local-coverage",
      baselineKleePath: coverageExecution?.executionMode || "unknown",
      runInParallel: true,
      parallelismGuidance: [
        "Parallelize independent generated residual harness compile/replay/coverage jobs.",
        "Do not write the same generated harness/profraw/profdata path from multiple parallel jobs.",
        "Keep PerfectOne KLEE baseline evidence separate from Coding Agent residual MC/DC evidence."
      ],
      fallbackOrder: coverageExecution?.residualMcdcStrategy?.fallbackOrder || ["local-coverage"]
    },
    attemptAccounting: {
      maxAttemptsPerFunction: C_RESIDUAL_MAX_ATTEMPTS,
      runnerKleeRerunsCountAsCodingAgentAttempts: false,
      dockerKleeRerunsCountAsCodingAgentAttempts: false,
      codingAgentAttemptDefinition: "one coding-agent-generated harness, fixture, stub, or testcase-input change followed by Windows local LLVM/lld-link MC/DC compile/replay/coverage remeasurement when available, otherwise the configured fallback path",
      mustModifyGeneratedArtifact: true,
      allowedWriteScope: "generated verification artifacts only; do not modify the user source file to raise coverage",
      earlyStopAllowedBeforeMaxAttempts: true,
      continueAfterCoverageIncrease: true,
      oneIncreasingAttemptIsNotEnough: true,
      earlyStopRequires: [
        "requested_goal_reached",
        "one_coding_agent_attempt_without_any_function_line_branch_or_mcdc_coverage_increase_plus_max_coverage_or_infeasible_or_crash_risk_or_toolchain_blocked_evidence"
      ]
    },
    targets,
    instructions: targets.length > 0 ? [
      `Run Coding Agent residual repair toward the 100% coverage goal for up to ${C_RESIDUAL_MAX_ATTEMPTS} attempts.`,
      "Use Windows local LLVM 21+ with lld-link as the first residual MC/DC measurement path when available: clang -O0 -g -fprofile-instr-generate -fcoverage-mapping -fcoverage-mcdc -fuse-ld=lld -Wl,/INCREMENTAL:NO <generated_harness.c> -o <test.exe>.",
      "Run independent residual compile/replay/coverage jobs in parallel when their generated artifacts and profile output paths are disjoint.",
      "If Windows local LLVM/lld-link is missing, ask the user before installing LLVM; do not silently install it.",
      "Fallback order after Windows local residual MC/DC is explicit Docker, then local no-KLEE coverage with a clear no-KLEE diagnostic.",
      "The coding agent must directly edit generated harnesses, fixtures, stubs, or testcase inputs to increase coverage; do not only rerun PerfectOne or the baseline runner, and do not only regenerate reports.",
      "Do not count Docker/local KLEE reruns, PerfectOne reruns, report regeneration, or global coverage reruns as coding-agent residual attempts.",
      "Each coding-agent residual attempt must name the target function, uncovered line/branch/MC/DC gap, changed generated artifact, replay command, before coverage, after coverage, best coverage, and stop reason.",
      "If an attempt increases coverage and the 100% goal is still unmet, immediately run the next coding-agent residual attempt.",
      `Do not stop before attempt ${C_RESIDUAL_MAX_ATTEMPTS} unless the 100% goal is reached, or a coding-agent attempt shows no increase and the remaining gap has max-coverage/infeasible/crash-risk/toolchain-blocked evidence.`
    ] : []
  };
}

function buildCodingAgentResidualRepairPrompt(plan) {
  if (!plan?.executionRequired) {
    return "No Coding Agent residual repair is required because no source-target function is below the 100% coverage goal.";
  }
  const targetSummary = (plan.targets || [])
    .slice(0, 40)
    .map((item) => `${item.function}(${item.unmetMetrics.join("+") || item.reason})`)
    .join(", ");
  return [
    "Coding Agent residual repair is required now.",
    `Targets: ${targetSummary || "unknown"}.`,
    `For each target function, run up to ${plan.attemptAccounting.maxAttemptsPerFunction} coding-agent attempts.`,
    `Preferred residual MC/DC path: ${plan.executionStrategy?.first || "local coverage"}.`,
    "A coding-agent attempt is a direct generated harness/fixture/stub/testcase-input edit followed by Windows local LLVM/lld-link compile, replay, and coverage remeasurement when available.",
    "Run independent residual jobs in parallel if their generated artifacts and profile output paths are disjoint.",
    "The coding agent must directly modify generated verification artifacts to raise coverage; do not modify the user source file.",
    "Docker/local KLEE reruns and PerfectOne reruns do not count as coding-agent residual attempts.",
    "If a residual attempt increases coverage but the 100% goal is still unmet, the next attempt is mandatory.",
    `Do not stop before attempt ${plan.attemptAccounting.maxAttemptsPerFunction} unless coverage reaches the 100% goal, or one coding-agent attempt shows no increase and the remaining gap has max-coverage/infeasible/crash-risk/toolchain-blocked evidence.`,
    "The final report must include attempt history per function with before/after/best coverage and stop reason."
  ].join(" ");
}

function buildCodingAgentResidualActionRequired(plan, coverageExecution) {
  if (!plan?.executionRequired) {
    return {
      required: false,
      completionBlocked: false,
      finalAnswerAllowed: true,
      nextRequiredAction: null,
      message: "No coding-agent residual repair is required."
    };
  }
  const targetCount = plan.targets?.length || 0;
  return {
    required: true,
    completionBlocked: true,
    finalAnswerAllowed: false,
    nextRequiredAction: "execute_coding_agent_residual_repair_loop",
    owner: "Active Coding Agent",
    reason: "PerfectOne filtered KLEE/MC/DC baseline is below the 100% coverage goal for one or more source-target functions.",
    baseline: plan.baseline || null,
    targetCount,
    maxAttemptsPerFunction: plan.attemptAccounting?.maxAttemptsPerFunction ?? C_RESIDUAL_MAX_ATTEMPTS,
    attemptDefinition: plan.attemptAccounting?.codingAgentAttemptDefinition || "generated artifact edit plus replay and coverage remeasurement",
    prohibitedShortcuts: [
      "Do not stop with a summary of needs_coding_agent_residual.",
      "Do not count Docker/local KLEE reruns or PerfectOne reruns as coding-agent residual attempts.",
      "Do not modify the user's original C source just to raise coverage.",
      "Do not leave Coding Agent Applied Cumulative coverage as pending in the final report."
    ],
    requiredEvidence: [
      "changed generated harness/fixture/stub/testcase input path",
      "compile command",
      "replay command",
      "before coverage",
      "after coverage",
      "best coverage",
      "coverage increase delta for function/line/branch/MC/DC",
      "stop reason per residual function"
    ],
    recommendedLocalCoverage: coverageExecution?.executionMode === "docker"
      ? "Use Windows local LLVM/lld-link MC/DC replay for generated residual harnesses when available while preserving Docker KLEE/MC/DC as the PerfectOne baseline."
      : "Use Windows local LLVM/lld-link MC/DC replay for generated residual harnesses when available; otherwise use the configured fallback path.",
    residualMcdcStrategy: plan.residualMcdcStrategy || null,
    executionStrategy: plan.executionStrategy || null,
    message: [
      `Coding-agent residual repair is mandatory before the final answer. ${targetCount} source-target functions remain below goal.`,
      `Run up to ${plan.attemptAccounting?.maxAttemptsPerFunction ?? C_RESIDUAL_MAX_ATTEMPTS} generated-artifact edit/replay/remeasure attempts per function.`,
      "If a residual attempt increases coverage but the 100% goal is still unmet, continue with the next attempt instead of producing a final answer.",
      "After residual repair, update the final HTML/report so Coding Agent Applied Cumulative coverage is numeric and Coding Agent Increase is +N%, not +pending."
    ].join(" ")
  };
}

function buildCUnitVerificationFlow({ report, targetFunctionFilter, functionReports, result, coverageExecution = null, residualTargets = null, testAugmentationPlan = null }) {
  const missingFromMcp = sourceTargetsMissingFromFunctionReports(targetFunctionFilter, functionReports);
  const dockerDiscovered = coverageExecution?.candidateCounts?.dockerDiscovered ?? null;
  const sourceTargetCount = targetFunctionFilter?.functionCount ?? null;
  const residualFunctions = residualTargets || (targetFunctionFilter?.functions || []).map((name) => ({ function: name, reason: "coverage_not_yet_measured" }));
  const cumulative = coverageCumulativeFromPerfectOne(coverageExecution?.coverage);
  const augmentationPlan = testAugmentationPlan || buildCodingAgentTestAugmentationPlan({
    language: "c",
    sourceFiles: targetFunctionFilter?.sourceFiles || [],
    hasSpecification: Boolean(report?.unitDesignArtifacts && (Array.isArray(report.unitDesignArtifacts) ? report.unitDesignArtifacts.length > 0 : true)),
    baselineKind: "PerfectOne filtered KLEE/MC/DC",
    baselineReady: Boolean(coverageExecution?.coverage),
    coverageExecution,
    residualTargets: residualFunctions
  });
  return {
    language: "c",
    defaultSequence: [
      "mcp_cli_artifact_generation",
      "source_file_target_filter",
      "filtered_klee_coverage_mcdc",
      "coding_agent_residual_fill",
      "coding_agent_test_augmentation"
    ],
    artifactGeneration: {
      mcpStatus: report?.mcpStatus || report?.status || "unknown",
      coverageUnmetIsFailure: false,
      producedArtifactsOnly: report?.status === "coverage_unmet",
      initialGeneration: {
        startedAt: result?.startedAt || null,
        completedAt: result?.completedAt || null,
        elapsedMs: result?.elapsedMs ?? null
      }
    },
    targetFilter: {
      requiredForDocker: true,
      mode: targetFunctionFilter?.mode || null,
      filterSource: targetFunctionFilter?.filterSource || null,
      regex: targetFunctionFilter?.regex || null,
      sourceFiles: targetFunctionFilter?.sourceFiles || [],
      irPath: targetFunctionFilter?.irPath || null,
      functions: targetFunctionFilter?.functions || [],
      missingFromMcpFunctionReports: missingFromMcp
    },
    candidateCounts: {
      sourceTargets: sourceTargetCount,
      mcpFunctionReports: functionReports?.length ?? null,
      dockerDiscovered,
      headerOrSystemTargetsDetected: dockerDiscovered !== null && sourceTargetCount !== null && dockerDiscovered > sourceTargetCount
    },
    coverageExecution: coverageExecution || {
      runner: "not_run",
      executionMode: "not_run",
      docker: { attempted: false, executed: false, filtered: true, requiredFuncRegex: targetFunctionFilter?.regex || null },
      local: { attempted: false, executed: false },
      native: { attempted: false, executed: false },
      klee: { attempted: false, executed: false },
      mcdc: { attempted: false, measured: false, value: null },
      targetSourceFiles: targetFunctionFilter?.sourceFiles || [],
      filterSource: targetFunctionFilter?.filterSource || null,
      artifacts: {}
    },
    codingAgentResidual: {
      mode: "residual-fill-only",
      scope: "Every source-target function with coverage below 100% after PerfectOne filtered KLEE/MC/DC, including but not limited to functions missing from MCP runner reports.",
      harnessOnlyMayReplaceKlee: false,
      residualMcdcStrategy: coverageExecution?.residualMcdcStrategy || null,
      missingFromMcpFunctionReports: missingFromMcp,
      residualTargetCount: residualFunctions.length,
      iterationPolicy: {
        mode: "per-function-coverage-growth-loop",
        owner: "Coding Agent",
        mcpRecommendation: false,
        firstMeasurementPath: coverageExecution?.residualMcdcStrategy?.defaultPath || "local-coverage",
        parallelExecution: true,
        fallbackOrder: coverageExecution?.residualMcdcStrategy?.fallbackOrder || ["local-coverage"],
        maxAttempts: C_RESIDUAL_MAX_ATTEMPTS,
        noImprovementLimit: C_RESIDUAL_NO_IMPROVEMENT_LIMIT,
        targetSelection: "all source-target functions whose function, line, branch, or MC/DC coverage is below the 100% goal after PerfectOne filtered KLEE/MC/DC baseline; do not limit residual work to functions missing from runner discovery",
        attemptUnit: "one coding-agent-generated harness, fixture, stub, or testcase-input change followed by Windows local LLVM/lld-link MC/DC replay when available; Docker/local KLEE reruns do not count as coding-agent residual attempts",
        mustDirectlyModifyGeneratedArtifacts: true,
        continuationRule: "a coverage-increasing coding-agent attempt is never sufficient by itself when the 100% goal remains unmet; continue to the next attempt",
        stopRule: `run Coding Agent residual repair up to ${C_RESIDUAL_MAX_ATTEMPTS} attempts. Stop before attempt ${C_RESIDUAL_MAX_ATTEMPTS} only if the 100% goal is reached, or if one coding-agent attempt shows no coverage increase and the remaining gap is classified with evidence as max-coverage, infeasible, crash-risk, or toolchain-blocked. Docker/local KLEE reruns are not coding-agent residual attempts`
      },
      perFunction: residualFunctions.map(codingAgentResidualLoopForFunction)
    },
    codingAgentTestAugmentation: augmentationPlan,
    coverageCumulative: cumulative,
    timing: {
      initialGenerationMs: result?.elapsedMs ?? null,
      replayMs: coverageExecution?.timing?.replayMs ?? null,
      codingAgentResidualMs: coverageExecution?.timing?.codingAgentResidualMs ?? null
    }
  };
}

function boolText(value) {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}

function renderMarkdownReport(report, diagnosticSummary) {
  const cFlow = report.cUnitVerificationFlow || {};
  const coverage = cFlow.coverageExecution || {};
  const counts = cFlow.candidateCounts || {};
  const failureEvidence = report.failureEvidence || { summary: { total: 0 }, cases: [] };
  const tokenUsage = report.tokenUsage || null;
  const reportLinks = report.reportLinks || {};
  const linkRows = Object.entries(reportLinks)
    .map(([key, value]) => `<tr><td>${htmlEscape(key)}</td><td><a href="${htmlEscape(String(value).replace(/\\/g, "/"))}">${htmlEscape(value)}</a></td></tr>`)
    .join("\n");
  const lines = [
    "# PerfectOne Unit Verify Report",
    "",
    `- status: ${report.status}`,
    `- runId: ${report.runId || "unknown"}`,
    `- diagnostics: ${diagnosticSummary.total} total, ${diagnosticSummary.blocking} blocking`,
    `- final answer allowed: ${report.finalAnswerAllowed === false ? "no" : "yes"}`,
    `- next required action: ${report.nextRequiredAction || "none"}`
  ];
  if (report.cUnitVerificationFlow) {
    const dockerPrep = coverage.docker?.preparation?.before || null;
    lines.push(
      `- mcp status: ${cFlow.artifactGeneration?.mcpStatus || report.status}`,
      `- execution mode: ${coverage.executionMode || "not run"}`,
      `- runner: ${coverage.runner || "not run"}`,
      `- runner policy: ${coverage.runnerPolicy || "os-default"}`,
      `- execution profile: ${coverage.executionProfile || coverage.coverageOptions?.executionProfile || "quick"}`,
      `- WSL disabled: ${boolText(coverage.wsl?.disabled ?? coverage.wslDisabled)}`,
      `- Docker explicit: ${boolText(coverage.dockerExplicit)}`,
      `- docker executed: ${boolText(coverage.docker?.executed)}`,
      `- docker prepared image: ${dockerPrep?.preparedImage || PREPARED_KLEE_DOCKER_IMAGE}`,
      `- docker prepared image present: ${dockerPrep?.preparedImagePresent === null || dockerPrep?.preparedImagePresent === undefined ? "unknown" : boolText(dockerPrep.preparedImagePresent)}`,
      `- docker first-run preparation: ${dockerPrep?.firstRunWillPrepare ? `yes (${dockerPrep.estimatedFirstPrepareTime})` : "no"}`,
      `- Docker install command: ${dockerPrep?.installCommand || "not required/reported"}`,
      `- Docker setup commands: ${(dockerPrep?.setupCommands || []).join(" ; ") || "not required/reported"}`,
      `- Docker execution command: ${coverage.runnerCommands?.docker_run_command || "not captured"}`,
      `- Docker execution command log: ${coverage.runnerCommands?.docker_run_command_log || "not captured"}`,
      `- Docker exec template: ${coverage.runnerCommands?.docker_exec_template || "not captured"}`,
      `- local executed: ${boolText(coverage.local?.executed)}`,
      `- KLEE executed: ${boolText(coverage.klee?.executed)}`,
      `- MCDC measured: ${boolText(coverage.mcdc?.measured)}${coverage.mcdc?.value !== null && coverage.mcdc?.value !== undefined ? ` (${coverage.mcdc.value}%)` : ""}`,
      `- residual MC/DC first path: ${coverage.residualMcdcStrategy?.defaultPath || "unknown"}`,
      `- Windows local residual MC/DC ready: ${boolText(coverage.residualMcdcStrategy?.windowsLocalMcdc?.available)}`,
      `- residual parallel policy: ${coverage.residualMcdcStrategy?.parallelPolicy || "unknown"}`,
      `- target source files: ${(cFlow.targetFilter?.sourceFiles || []).join(", ") || "unknown"}`,
      `- filter source: ${cFlow.targetFilter?.filterSource || "unknown"}`,
      `- function regex: ${cFlow.targetFilter?.regex || "unknown"}`,
      `- source target functions: ${counts.sourceTargets ?? "unknown"}`,
      `- MCP functionReports: ${counts.mcpFunctionReports ?? "unknown"}`,
      `- Docker discovered functions: ${counts.dockerDiscovered ?? "not run"}`,
      `- initial generation ms: ${cFlow.timing?.initialGenerationMs ?? "unknown"}`,
      `- replay ms: ${cFlow.timing?.replayMs ?? "not run"}`,
      `- replay cap per function: ${coverage.replayPolicy?.replayMaxCasesPerFunction ?? coverage.coverageOptions?.replayMaxCasesPerFunction ?? "unknown"}`,
      `- replay dedup: ${coverage.replayPolicy?.replayDedup ?? coverage.coverageOptions?.replayDedup ?? "unknown"}`,
      `- native replay timeout: ${coverage.replayPolicy?.nativeReplayTimeout ?? coverage.coverageOptions?.nativeReplayTimeout ?? "unknown"} sec`,
      `- Docker KLEE parallel: ${boolText(coverage.replayPolicy?.dockerKleeParallel)}`,
      `- Windows local residual parallel: ${boolText(coverage.replayPolicy?.windowsLocalResidualParallel)}`,
      `- testcase counts: ${renderValue(coverage.performance?.testcaseCounts || {})}`,
      `- coverage options source: ${coverage.coverageOptions?.source || "unknown"}`,
      `- heterogeneous: ${coverage.coverageOptions?.heterogeneous === null || coverage.coverageOptions?.heterogeneous === undefined ? "default" : coverage.coverageOptions.heterogeneous}`,
      `- struct depth: ${coverage.coverageOptions?.structDepth?.value ?? "default"}${coverage.coverageOptions?.structDepth?.clamped ? ` (clamped from ${coverage.coverageOptions.structDepth.requested})` : ""}`,
      `- pointer array size: ${coverage.coverageOptions?.pointerArraySize ?? "default"}`,
      `- array max dims: ${coverage.coverageOptions?.arrayMaxDims ?? "default"}`,
      `- fam size: ${coverage.coverageOptions?.famSize ?? "default"}`
    );
    const cumulative = cFlow.coverageCumulative || {};
    const applied = cumulative.codingAgentAppliedCumulative || {};
    const increase = cumulative.codingAgentIncrease?.display || {};
    lines.push(
      `- residual loop mode: ${cFlow.codingAgentResidual?.iterationPolicy?.mode || "unknown"}`,
      `- residual first measurement path: ${cFlow.codingAgentResidual?.iterationPolicy?.firstMeasurementPath || "unknown"}`,
      `- residual parallel execution: ${boolText(cFlow.codingAgentResidual?.iterationPolicy?.parallelExecution)}`,
      `- residual max attempts: ${cFlow.codingAgentResidual?.iterationPolicy?.maxAttempts ?? "unknown"}`,
      `- residual early-stop evidence threshold: ${cFlow.codingAgentResidual?.iterationPolicy?.noImprovementLimit ?? "unknown"} no-improvement coding-agent attempts plus max-coverage/infeasible evidence`,
      `- residual target count: ${cFlow.codingAgentResidual?.residualTargetCount ?? (cFlow.codingAgentResidual?.perFunction || []).length}`,
      `- coding-agent test augmentation required: ${boolText(cFlow.codingAgentTestAugmentation?.executionRequired)}`,
      `- code-only augmentation methods: ${((cFlow.codingAgentTestAugmentation?.codeOnlyDefault?.methods || []).map((item) => `${item.designMethod}:${item.status || item.required}`).join(", ") || "unknown")}`,
      `- specification-driven methods: ${((cFlow.codingAgentTestAugmentation?.specificationDriven?.methods || []).map((item) => `${item.designMethod}:${item.status || item.required}`).join(", ") || "unknown")}`,
      `- PerfectOne Coverage: line=${cumulative.perfectOne?.line ?? "unknown"}%, branch=${cumulative.perfectOne?.branch ?? "unknown"}%, function=${cumulative.perfectOne?.function ?? "unknown"}%, MC/DC=${cumulative.perfectOne?.mcdc ?? "unknown"}%`,
      `- Coding Agent Applied Cumulative: ${applied.status || "pending"}`,
      `- Coding Agent Increase: line=${increase.line || "+pending"}, branch=${increase.branch || "+pending"}, function=${increase.function || "+pending"}, MC/DC=${increase.mcdc || "+pending"}`
    );
    const residualItems = cFlow.codingAgentResidual?.perFunction || [];
    if (residualItems.length) {
      lines.push("", "## Coding Agent Residual Targets", "");
      for (const item of residualItems.slice(0, 80)) {
        const unmet = Object.keys(item.unmetMetrics || {}).join(", ") || "coverage_below_goal";
        lines.push(`- ${item.function}: ${item.reason || "coverage_below_goal"}; unmet=${unmet}; goal=${item.goal ?? C_COVERAGE_GOAL_PERCENT}%`);
      }
    }
    if (report.codingAgentResidualRepairPlan?.executionRequired) {
      lines.push("", "## Coding Agent Residual Repair Plan", "");
      lines.push(`- completion blocked: ${boolText(report.completionBlocked)}`);
      lines.push(`- final answer allowed: ${report.finalAnswerAllowed === false ? "no" : "yes"}`);
      lines.push(`- next required action: ${report.nextRequiredAction || "execute_coding_agent_residual_repair_loop"}`);
      lines.push(`- max attempts per function: ${report.codingAgentResidualRepairPlan.attemptAccounting?.maxAttemptsPerFunction ?? C_RESIDUAL_MAX_ATTEMPTS}`);
      lines.push(`- Runner KLEE reruns count as coding-agent attempts: ${boolText(report.codingAgentResidualRepairPlan.attemptAccounting?.runnerKleeRerunsCountAsCodingAgentAttempts ?? report.codingAgentResidualRepairPlan.attemptAccounting?.dockerKleeRerunsCountAsCodingAgentAttempts)}`);
      lines.push(`- coding-agent attempt: ${report.codingAgentResidualRepairPlan.attemptAccounting?.codingAgentAttemptDefinition || "generated artifact change plus replay and coverage remeasurement"}`);
      lines.push(`- prompt: ${report.codingPlatformPrompt || ""}`);
    }
  }
  if (tokenUsage) {
    lines.push(
      `- input estimated tokens: ${tokenUsage.input?.estimatedTokens ?? "unknown"}`,
      `- output estimated tokens: ${tokenUsage.output?.estimatedTokens ?? "unknown"}`,
      `- total estimated tokens: ${tokenUsage.total?.estimatedTokens ?? "unknown"}`
    );
  }
  lines.push("", "## Failure Evidence", "");
  if ((failureEvidence.summary?.total || 0) === 0) {
    lines.push("- No segfault, runtime crash, KLEE error, or expected-value mismatch evidence was collected.");
  } else {
    lines.push(
      `- total: ${failureEvidence.summary.total}`,
      `- segfaults: ${failureEvidence.summary.segfaults || 0}`,
      `- runtime crashes: ${failureEvidence.summary.runtimeCrashes || 0}`,
      `- KLEE errors: ${failureEvidence.summary.kleeErrors || 0}`,
      `- expected mismatches: ${failureEvidence.summary.expectedMismatches || 0}`,
      `- replay tool: ${failureEvidence.replay?.mcpTool || "none"}`
    );
    for (const item of (failureEvidence.cases || []).slice(0, 20)) {
      lines.push(
        "",
        `### ${item.type} ${item.function ? `- ${item.function}` : ""}`,
        `- testcase: ${item.testcaseId || "unknown"}`,
        `- input: ${truncate(renderValue(item.input), 1200)}`,
        `- expected: ${truncate(renderValue(item.expected), 1200)}`,
        `- actual: ${truncate(renderValue(item.actual), 1200)}`,
        `- replay: ${item.replay?.mcpTool || "none"} ${truncate(renderValue(item.replay?.arguments), 1200)}`,
        `- artifacts: ${renderArtifactSummary(item.artifacts)}`
      );
    }
  }
  if (tokenUsage) {
    lines.push("", "## Token Usage", "");
    lines.push(`- method: ${tokenUsage.tokenizer || "unknown"}${tokenUsage.approximation ? " (approximate)" : ""}`);
    lines.push(`- scope: ${tokenUsage.scope || "unknown"}`);
    lines.push(`- OAuth configured: ${boolText(tokenUsage.oauth?.configured)}; secret values recorded: ${boolText(tokenUsage.oauth?.secretValuesRecorded)}`);
    lines.push(`- input: ${tokenUsage.input?.estimatedTokens ?? "unknown"} tokens, ${tokenUsage.input?.chars ?? "unknown"} chars, ${tokenUsage.input?.bytes ?? "unknown"} bytes`);
    lines.push(`- output: ${tokenUsage.output?.estimatedTokens ?? "unknown"} tokens, ${tokenUsage.output?.chars ?? "unknown"} chars, ${tokenUsage.output?.bytes ?? "unknown"} bytes`);
    lines.push(`- total: ${tokenUsage.total?.estimatedTokens ?? "unknown"} tokens`);
    lines.push(`- observed surfaces: ${(tokenUsage.observedSurfaces || []).join(", ") || "unknown"}`);
  }
  lines.push("", "## Function Reports", "");
  for (const item of report.functionReports || []) {
    lines.push(`### ${item.symbol}`);
    lines.push(`- file: ${item.file || "unknown"}`);
    lines.push(`- verdict: ${item.verdict}`);
    lines.push(`- coverage: ${item.coverage.status}`);
    lines.push(`- harnesses: ${item.perfectOneArtifacts.harnesses.length}`);
    lines.push("");
  }
  lines.push("## Diagnostics", "");
  for (const diagnostic of report.diagnostics || []) {
    lines.push(`- [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
  }
  lines.push("", "## Coding Platform Actions", "");
  for (const action of report.codingPlatformActions || []) {
    lines.push(`- ${action}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderHtmlReport(report, diagnosticSummary) {
  const cFlow = report.cUnitVerificationFlow || {};
  const coverageExecution = cFlow.coverageExecution || {};
  const counts = cFlow.candidateCounts || {};
  const timing = cFlow.timing || {};
  const coverage = coverageExecution.coverage || {};
  const dockerPrep = coverageExecution.docker?.preparation?.before || null;
  const mcdcValue = coverageExecution.mcdc?.value ?? coverage.mcdc?.pct ?? null;
  const failureEvidence = report.failureEvidence || { summary: { total: 0 }, cases: [] };
  const tokenUsage = report.tokenUsage || null;
  const reportLinks = report.reportLinks || {};
  const linkRows = Object.entries(reportLinks)
    .map(([key, value]) => `<tr><td>${htmlEscape(key)}</td><td><a href="${htmlEscape(String(value).replace(/\\/g, "/"))}">${htmlEscape(value)}</a></td></tr>`)
    .join("\n");
  const functionRows = (report.functionReports || [])
    .map((item) =>
      `<tr><td>${htmlEscape(item.symbol)}</td><td>${htmlEscape(item.file)}</td><td>${htmlEscape(item.verdict)}</td><td>${htmlEscape(item.coverage.status)}</td></tr>`
    )
    .join("\n");
  const diagnosticRows = (report.diagnostics || [])
    .map((item) =>
      `<tr><td>${htmlEscape(item.severity)}</td><td>${htmlEscape(item.code)}</td><td>${htmlEscape(item.message)}</td></tr>`
    )
    .join("\n");
  const failureRows = (failureEvidence.cases || []).slice(0, 50)
    .map((item) => `<tr>
      <td>${htmlEscape(item.type)}</td>
      <td>${htmlEscape(item.function || "unknown")}</td>
      <td>${htmlEscape(item.testcaseId || "unknown")}</td>
      <td><pre>${htmlEscape(truncate(renderValue(item.input), 1200))}</pre></td>
      <td><pre>${htmlEscape(truncate(renderValue(item.expected), 1200))}</pre></td>
      <td><pre>${htmlEscape(truncate(renderValue(item.actual), 1200))}</pre></td>
      <td><code>${htmlEscape(item.replay?.mcpTool || "none")}</code><br><pre>${htmlEscape(truncate(renderValue(item.replay?.arguments), 800))}</pre></td>
      <td>${htmlEscape(truncate(item.message || renderArtifactSummary(item.artifacts), 1200))}<br><small>${htmlEscape(renderArtifactSummary(item.artifacts))}</small></td>
    </tr>`)
    .join("\n");
  const pctCell = (metric) => metric && typeof metric.pct === "number"
    ? `${htmlEscape(metric.pct)}% (${htmlEscape(metric.covered ?? metric.hit ?? "?")}/${htmlEscape(metric.total ?? "?")})`
    : "n/a";
  const residualRows = (cFlow.codingAgentResidual?.perFunction || []).slice(0, 120)
    .map((item) => `<tr>
      <td>${htmlEscape(item.function || "unknown")}</td>
      <td>${htmlEscape(item.reason || "coverage_below_goal")}</td>
      <td>${htmlEscape(Object.keys(item.unmetMetrics || {}).join(", ") || "coverage_below_goal")}</td>
      <td>${pctCell(item.coverage?.line)}</td>
      <td>${pctCell(item.coverage?.branch)}</td>
      <td>${pctCell(item.coverage?.function)}</td>
      <td>${pctCell(item.coverage?.mcdc)}</td>
      <td><code>${htmlEscape(item.source || "unknown")}</code></td>
    </tr>`)
    .join("\n");
  const failureSection = `
  <h2>Failure Evidence and Replay</h2>
  <p>
    <strong>Total:</strong> ${htmlEscape(failureEvidence.summary?.total || 0)}
    &nbsp; <strong>Segfaults:</strong> ${htmlEscape(failureEvidence.summary?.segfaults || 0)}
    &nbsp; <strong>Runtime crashes:</strong> ${htmlEscape(failureEvidence.summary?.runtimeCrashes || 0)}
    &nbsp; <strong>KLEE errors:</strong> ${htmlEscape(failureEvidence.summary?.kleeErrors || 0)}
    &nbsp; <strong>Expected mismatches:</strong> ${htmlEscape(failureEvidence.summary?.expectedMismatches || 0)}
  </p>
  <p><strong>Replay MCP tool:</strong> <code>${htmlEscape(failureEvidence.replay?.mcpTool || "perfectone_replay")}</code>
  <br><strong>Replay args:</strong> <code>${htmlEscape(renderValue(failureEvidence.replay?.arguments || {}))}</code></p>
  <table><thead><tr><th>Type</th><th>Function</th><th>Testcase</th><th>Input</th><th>Expected</th><th>Actual</th><th>Replay</th><th>Evidence</th></tr></thead><tbody>
    ${failureRows || '<tr><td colspan="8">No segfault, runtime crash, KLEE error, or expected-value mismatch evidence was collected.</td></tr>'}
  </tbody></table>`;
  const tokenRows = (tokenUsage?.items || [])
    .map((item) => `<tr><td>${htmlEscape(item.direction)}</td><td>${htmlEscape(item.name)}</td><td>${htmlEscape(item.chars)}</td><td>${htmlEscape(item.bytes)}</td><td>${htmlEscape(item.estimatedTokens)}</td></tr>`)
    .join("\n");
  const tokenSection = tokenUsage ? `
  <h2>Token Usage</h2>
  <p><strong>Scope:</strong> ${htmlEscape(tokenUsage.scope || "unknown")}
  <br><strong>Method:</strong> ${htmlEscape(tokenUsage.tokenizer || "unknown")}${tokenUsage.approximation ? " (approximate)" : ""}
  <br><strong>OAuth configured:</strong> ${htmlEscape(boolText(tokenUsage.oauth?.configured))}
  <br><strong>OAuth secret values recorded:</strong> ${htmlEscape(boolText(tokenUsage.oauth?.secretValuesRecorded))}
  <br><strong>Observed surfaces:</strong> ${htmlEscape((tokenUsage.observedSurfaces || []).join(", ") || "unknown")}
  <br><strong>Input:</strong> ${htmlEscape(tokenUsage.input?.estimatedTokens ?? "unknown")} tokens, ${htmlEscape(tokenUsage.input?.chars ?? "unknown")} chars, ${htmlEscape(tokenUsage.input?.bytes ?? "unknown")} bytes
  <br><strong>Output:</strong> ${htmlEscape(tokenUsage.output?.estimatedTokens ?? "unknown")} tokens, ${htmlEscape(tokenUsage.output?.chars ?? "unknown")} chars, ${htmlEscape(tokenUsage.output?.bytes ?? "unknown")} bytes
  <br><strong>Total:</strong> ${htmlEscape(tokenUsage.total?.estimatedTokens ?? "unknown")} tokens</p>
  <table><thead><tr><th>Direction</th><th>Name</th><th>Chars</th><th>Bytes</th><th>Estimated Tokens</th></tr></thead><tbody>${tokenRows}</tbody></table>` : "";
  const repairPlan = report.codingAgentResidualRepairPlan || {};
  const repairPlanRows = (repairPlan.targets || []).slice(0, 120)
    .map((item) => `<tr>
      <td>${htmlEscape(item.function || "unknown")}</td>
      <td>${htmlEscape(item.reason || "coverage_below_goal")}</td>
      <td>${htmlEscape((item.unmetMetrics || []).join(", ") || "coverage_below_goal")}</td>
      <td>${htmlEscape(item.maxAttempts ?? C_RESIDUAL_MAX_ATTEMPTS)}</td>
      <td>${htmlEscape(item.earlyStopNoImprovementAttempts ?? C_RESIDUAL_NO_IMPROVEMENT_LIMIT)} no-increase coding-agent attempts plus max-coverage/infeasible evidence</td>
      <td><code>${htmlEscape(item.evidenceSource || "unknown")}</code></td>
    </tr>`)
    .join("\n");
  const augmentationPlan = cFlow.codingAgentTestAugmentation || report.codingAgentTestAugmentationPlan || {};
  const augmentationRows = [
    ...(augmentationPlan.codeOnlyDefault?.methods || []),
    ...(augmentationPlan.specificationDriven?.methods || [])
  ].map((item) => `<tr>
      <td>${htmlEscape(item.designMethod || "unknown")}</td>
      <td>${htmlEscape(item.executionCategory || "unknown")}</td>
      <td>${htmlEscape(item.required || "unknown")}</td>
      <td>${htmlEscape(item.status || "unknown")}</td>
      <td>${htmlEscape(item.executionRequired === undefined ? "review" : boolText(item.executionRequired))}</td>
      <td>${htmlEscape(item.designReason || "")}</td>
      <td>${htmlEscape(item.reportRequirement || "")}</td>
    </tr>`)
    .join("\n");
  const augmentationSection = augmentationPlan.schemaVersion ? `
  <h2>Coding Agent Additional Test Augmentation</h2>
  <p>After the baseline run, the coding agent must add and execute code-derived testcases. Coverage growth, boundary value, and equivalence partition tests are mandatory even when only source code was provided. UB corner tests are generated only when source review finds a plausible risk. When a specification is provided, decision table, state transition, boundary value, and equivalence partition tests must include the application reason in the final report.</p>
  <table><tbody>
    <tr><th>Execution required</th><td>${htmlEscape(boolText(augmentationPlan.executionRequired))}</td></tr>
    <tr><th>Placement</th><td>${htmlEscape(augmentationPlan.placement || "after baseline coverage")}</td></tr>
    <tr><th>Has specification</th><td>${htmlEscape(boolText(augmentationPlan.hasSpecification))}</td></tr>
    <tr><th>Baseline ready</th><td>${htmlEscape(boolText(augmentationPlan.baselineReady))}</td></tr>
    <tr><th>Residual target count</th><td>${htmlEscape(augmentationPlan.residualIntegration?.residualTargetCount ?? "unknown")}</td></tr>
  </tbody></table>
  <table><thead><tr><th>Design method</th><th>Execution category</th><th>Required</th><th>Status</th><th>Execute</th><th>Application reason</th><th>Report requirement</th></tr></thead><tbody>
    ${augmentationRows || '<tr><td colspan="7">No augmentation policy was generated.</td></tr>'}
  </tbody></table>` : "";
  const repairPlanSection = repairPlan.executionRequired ? `
  <h2>Coding Agent Residual Repair Plan</h2>
  <p>The coding agent must execute this plan after the PerfectOne filtered KLEE/MC/DC baseline. It must directly edit generated harnesses, fixtures, stubs, or testcase inputs, then replay and remeasure coverage. Docker/local KLEE reruns, PerfectOne reruns, report regeneration, and global coverage reruns do not count as coding-agent residual attempts.</p>
  <table><tbody>
    <tr><th>Completion blocked</th><td>${htmlEscape(boolText(report.completionBlocked))}</td></tr>
    <tr><th>Final answer allowed</th><td>${htmlEscape(report.finalAnswerAllowed === false ? "no" : "yes")}</td></tr>
    <tr><th>Next required action</th><td>${htmlEscape(report.nextRequiredAction || "execute_coding_agent_residual_repair_loop")}</td></tr>
    <tr><th>Owner</th><td>${htmlEscape(repairPlan.owner || "Coding Agent")}</td></tr>
    <tr><th>Max attempts per function</th><td>${htmlEscape(repairPlan.attemptAccounting?.maxAttemptsPerFunction ?? C_RESIDUAL_MAX_ATTEMPTS)}</td></tr>
    <tr><th>Coding-agent attempt definition</th><td>${htmlEscape(repairPlan.attemptAccounting?.codingAgentAttemptDefinition || "generated harness/fixture/stub/testcase input change plus replay and coverage remeasurement")}</td></tr>
    <tr><th>Must modify generated artifact</th><td>${htmlEscape(boolText(repairPlan.attemptAccounting?.mustModifyGeneratedArtifact))}</td></tr>
    <tr><th>Runner KLEE reruns count as coding-agent attempts</th><td>${htmlEscape(boolText(repairPlan.attemptAccounting?.runnerKleeRerunsCountAsCodingAgentAttempts ?? repairPlan.attemptAccounting?.dockerKleeRerunsCountAsCodingAgentAttempts))}</td></tr>
    <tr><th>Prompt</th><td>${htmlEscape(report.codingPlatformPrompt || "")}</td></tr>
  </tbody></table>
  <table><thead><tr><th>Function</th><th>Reason</th><th>Unmet metrics</th><th>Max attempts</th><th>Early stop</th><th>Evidence source</th></tr></thead><tbody>
    ${repairPlanRows || '<tr><td colspan="6">No repair targets.</td></tr>'}
  </tbody></table>` : "";
  const cCoverageSection = report.cUnitVerificationFlow ? `
  <h2>C Coverage Flow</h2>
  <table><tbody>
    <tr><th>Execution mode</th><td>${htmlEscape(coverageExecution.executionMode || "not run")}</td></tr>
    <tr><th>Runner</th><td>${htmlEscape(coverageExecution.runner || "not run")}</td></tr>
    <tr><th>Runner policy</th><td>${htmlEscape(coverageExecution.runnerPolicy || "os-default")}</td></tr>
    <tr><th>Execution profile</th><td>${htmlEscape(coverageExecution.executionProfile || coverageExecution.coverageOptions?.executionProfile || "quick")}</td></tr>
    <tr><th>WSL disabled</th><td>${htmlEscape(boolText(coverageExecution.wsl?.disabled ?? coverageExecution.wslDisabled))}</td></tr>
    <tr><th>Docker explicit</th><td>${htmlEscape(boolText(coverageExecution.dockerExplicit))}</td></tr>
    <tr><th>Docker executed</th><td>${htmlEscape(boolText(coverageExecution.docker?.executed))}</td></tr>
    <tr><th>Docker prepared image</th><td>${htmlEscape(dockerPrep?.preparedImage || PREPARED_KLEE_DOCKER_IMAGE)}</td></tr>
    <tr><th>Docker prepared image present</th><td>${htmlEscape(dockerPrep?.preparedImagePresent === null || dockerPrep?.preparedImagePresent === undefined ? "unknown" : boolText(dockerPrep.preparedImagePresent))}</td></tr>
    <tr><th>Docker first-run preparation</th><td>${htmlEscape(dockerPrep?.firstRunWillPrepare ? `yes (${dockerPrep.estimatedFirstPrepareTime})` : "no")}</td></tr>
    <tr><th>Docker install command</th><td><pre>${htmlEscape(dockerPrep?.installCommand || "not required/reported")}</pre></td></tr>
    <tr><th>Docker setup commands</th><td><pre>${htmlEscape((dockerPrep?.setupCommands || []).join("\n") || "not required/reported")}</pre></td></tr>
    <tr><th>Docker execution command</th><td><pre>${htmlEscape(coverageExecution.runnerCommands?.docker_run_command || "not captured")}</pre></td></tr>
    <tr><th>Docker execution command log</th><td>${htmlEscape(coverageExecution.runnerCommands?.docker_run_command_log || "not captured")}</td></tr>
    <tr><th>Docker exec template</th><td><pre>${htmlEscape(coverageExecution.runnerCommands?.docker_exec_template || "not captured")}</pre></td></tr>
    <tr><th>Local executed</th><td>${htmlEscape(boolText(coverageExecution.local?.executed))}</td></tr>
    <tr><th>KLEE executed</th><td>${htmlEscape(boolText(coverageExecution.klee?.executed))}</td></tr>
    <tr><th>MCDC measured</th><td>${htmlEscape(boolText(coverageExecution.mcdc?.measured))}${mcdcValue !== null && mcdcValue !== undefined ? ` (${htmlEscape(mcdcValue)}%)` : ""}</td></tr>
    <tr><th>Residual MC/DC first path</th><td>${htmlEscape(coverageExecution.residualMcdcStrategy?.defaultPath || "unknown")}</td></tr>
    <tr><th>Windows local LLVM/lld-link ready</th><td>${htmlEscape(boolText(coverageExecution.residualMcdcStrategy?.windowsLocalMcdc?.available))}</td></tr>
    <tr><th>Residual parallel policy</th><td>${htmlEscape(coverageExecution.residualMcdcStrategy?.parallelPolicy || "unknown")}</td></tr>
    <tr><th>Target source files</th><td>${htmlEscape((cFlow.targetFilter?.sourceFiles || []).join(", ") || "unknown")}</td></tr>
    <tr><th>Filter source</th><td>${htmlEscape(cFlow.targetFilter?.filterSource || "unknown")}</td></tr>
    <tr><th>Function regex</th><td>${htmlEscape(cFlow.targetFilter?.regex || "unknown")}</td></tr>
    <tr><th>Source target function count</th><td>${htmlEscape(counts.sourceTargets ?? "unknown")}</td></tr>
    <tr><th>MCP functionReports count</th><td>${htmlEscape(counts.mcpFunctionReports ?? "unknown")}</td></tr>
    <tr><th>Docker discovered function count</th><td>${htmlEscape(counts.dockerDiscovered ?? "not run")}</td></tr>
    <tr><th>Coding-agent residual scope</th><td>${htmlEscape(cFlow.codingAgentResidual?.scope || "residual-fill-only after filtered KLEE")}</td></tr>
    <tr><th>Initial generation time</th><td>${htmlEscape(timing.initialGenerationMs ?? "unknown")} ms</td></tr>
    <tr><th>Replay time</th><td>${htmlEscape(timing.replayMs ?? "not run")} ms</td></tr>
    <tr><th>Replay cap per function</th><td>${htmlEscape(coverageExecution.replayPolicy?.replayMaxCasesPerFunction ?? coverageExecution.coverageOptions?.replayMaxCasesPerFunction ?? "unknown")}</td></tr>
    <tr><th>Replay dedup</th><td>${htmlEscape(coverageExecution.replayPolicy?.replayDedup ?? coverageExecution.coverageOptions?.replayDedup ?? "unknown")}</td></tr>
    <tr><th>Native replay timeout</th><td>${htmlEscape(coverageExecution.replayPolicy?.nativeReplayTimeout ?? coverageExecution.coverageOptions?.nativeReplayTimeout ?? "unknown")} sec</td></tr>
    <tr><th>Docker KLEE parallel</th><td>${htmlEscape(boolText(coverageExecution.replayPolicy?.dockerKleeParallel))}</td></tr>
    <tr><th>Windows local residual parallel</th><td>${htmlEscape(boolText(coverageExecution.replayPolicy?.windowsLocalResidualParallel))}</td></tr>
    <tr><th>Execution path mode</th><td>${htmlEscape(coverageExecution.performance?.pathMode || "unknown")}</td></tr>
    <tr><th>Testcase counts</th><td><pre>${htmlEscape(renderValue(coverageExecution.performance?.testcaseCounts || {}))}</pre></td></tr>
    <tr><th>Coverage options source</th><td>${htmlEscape(coverageExecution.coverageOptions?.source || "unknown")}; MCP recommendation=${htmlEscape(boolText(coverageExecution.coverageOptions?.mcpRecommendation))}</td></tr>
    <tr><th>Heterogeneous exploration</th><td>${htmlEscape(coverageExecution.coverageOptions?.heterogeneous === null || coverageExecution.coverageOptions?.heterogeneous === undefined ? "PerfectOne default" : coverageExecution.coverageOptions.heterogeneous)}</td></tr>
    <tr><th>Struct depth</th><td>${htmlEscape(coverageExecution.coverageOptions?.structDepth?.value ?? "PerfectOne default")}${coverageExecution.coverageOptions?.structDepth?.clamped ? ` (clamped from ${htmlEscape(coverageExecution.coverageOptions.structDepth.requested)}; max ${htmlEscape(coverageExecution.coverageOptions.structDepth.max)})` : ""}</td></tr>
    <tr><th>Pointer array size</th><td>${htmlEscape(coverageExecution.coverageOptions?.pointerArraySize ?? "PerfectOne default")}</td></tr>
    <tr><th>Array max dims</th><td>${htmlEscape(coverageExecution.coverageOptions?.arrayMaxDims ?? "PerfectOne default")}</td></tr>
    <tr><th>FAM size</th><td>${htmlEscape(coverageExecution.coverageOptions?.famSize ?? "PerfectOne default")}</td></tr>
  </tbody></table>
  <h2>Residual Loop Policy</h2>
  <table><tbody>
    <tr><th>Mode</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.mode || "unknown")}</td></tr>
    <tr><th>Owner</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.owner || "Coding Agent")}</td></tr>
    <tr><th>First measurement path</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.firstMeasurementPath || "unknown")}</td></tr>
    <tr><th>Parallel execution</th><td>${htmlEscape(boolText(cFlow.codingAgentResidual?.iterationPolicy?.parallelExecution))}</td></tr>
    <tr><th>Fallback order</th><td>${htmlEscape((cFlow.codingAgentResidual?.iterationPolicy?.fallbackOrder || []).join(" -> ") || "unknown")}</td></tr>
    <tr><th>Max attempts</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.maxAttempts ?? "unknown")} coding-agent residual attempts per function</td></tr>
    <tr><th>Early-stop evidence threshold</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.noImprovementLimit ?? "unknown")} no-improvement coding-agent attempts plus max-coverage/infeasible/crash-risk/toolchain-blocked evidence. This is not the primary retry count.</td></tr>
    <tr><th>Target selection</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.targetSelection || "unknown")}</td></tr>
    <tr><th>Stop rule</th><td>${htmlEscape(cFlow.codingAgentResidual?.iterationPolicy?.stopRule || "unknown")}</td></tr>
    <tr><th>Per-function loop entries</th><td>${htmlEscape((cFlow.codingAgentResidual?.perFunction || []).length)}</td></tr>
  </tbody></table>
  <h2>Coding Agent Residual Targets</h2>
  <p>Residual targets are source functions whose function, line, branch, or MC/DC coverage is below the 100% goal after PerfectOne filtered KLEE/MC/DC. This is not limited to functions missing from Docker discovery.</p>
  <table><thead><tr><th>Function</th><th>Reason</th><th>Unmet metrics</th><th>Line</th><th>Branch</th><th>Function</th><th>MC/DC</th><th>Evidence source</th></tr></thead><tbody>
    ${residualRows || '<tr><td colspan="8">No coding-agent residual target was identified.</td></tr>'}
  </tbody></table>
  <h2>Coverage Cumulative</h2>
  <table><thead><tr><th>Metric</th><th>PerfectOne Coverage</th><th>Coding Agent Applied Cumulative</th><th>Coding Agent Increase</th></tr></thead><tbody>
    <tr><td>Line</td><td>${htmlEscape(cFlow.coverageCumulative?.perfectOne?.line ?? "unknown")}%</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentAppliedCumulative?.line ?? cFlow.coverageCumulative?.codingAgentAppliedCumulative?.status ?? "pending")}</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentIncrease?.display?.line || "+pending")}</td></tr>
    <tr><td>Branch</td><td>${htmlEscape(cFlow.coverageCumulative?.perfectOne?.branch ?? "unknown")}%</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentAppliedCumulative?.branch ?? cFlow.coverageCumulative?.codingAgentAppliedCumulative?.status ?? "pending")}</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentIncrease?.display?.branch || "+pending")}</td></tr>
    <tr><td>Function</td><td>${htmlEscape(cFlow.coverageCumulative?.perfectOne?.function ?? "unknown")}%</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentAppliedCumulative?.function ?? cFlow.coverageCumulative?.codingAgentAppliedCumulative?.status ?? "pending")}</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentIncrease?.display?.function || "+pending")}</td></tr>
    <tr><td>MC/DC</td><td>${htmlEscape(cFlow.coverageCumulative?.perfectOne?.mcdc ?? "unknown")}%</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentAppliedCumulative?.mcdc ?? cFlow.coverageCumulative?.codingAgentAppliedCumulative?.status ?? "pending")}</td><td>${htmlEscape(cFlow.coverageCumulative?.codingAgentIncrease?.display?.mcdc || "+pending")}</td></tr>
  </tbody></table>
  <h2>Coverage Numbers</h2>
  <table><thead><tr><th>Metric</th><th>Hit</th><th>Total</th><th>Percent</th></tr></thead><tbody>
    <tr><td>Line</td><td>${htmlEscape(coverage.line?.hit ?? "unknown")}</td><td>${htmlEscape(coverage.line?.total ?? "unknown")}</td><td>${htmlEscape(coverage.line?.pct ?? "unknown")}</td></tr>
    <tr><td>Branch</td><td>${htmlEscape(coverage.branch?.hit ?? "unknown")}</td><td>${htmlEscape(coverage.branch?.total ?? "unknown")}</td><td>${htmlEscape(coverage.branch?.pct ?? "unknown")}</td></tr>
    <tr><td>Function</td><td>${htmlEscape(coverage.function?.hit ?? "unknown")}</td><td>${htmlEscape(coverage.function?.total ?? "unknown")}</td><td>${htmlEscape(coverage.function?.pct ?? "unknown")}</td></tr>
    <tr><td>MCDC</td><td>${htmlEscape(coverage.mcdc?.hit ?? "unknown")}</td><td>${htmlEscape(coverage.mcdc?.total ?? "unknown")}</td><td>${htmlEscape(coverage.mcdc?.pct ?? "unknown")}</td></tr>
  </tbody></table>` : "";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PerfectOne Unit Verify Report</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #111827; }
    table { border-collapse: collapse; width: 100%; margin: 16px 0; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    code { background: #f3f4f6; padding: 2px 4px; }
    pre { white-space: pre-wrap; margin: 0; max-width: 520px; }
    small { color: #4b5563; }
  </style>
</head>
<body>
  <h1>PerfectOne Unit Verify Report</h1>
  <p><strong>Status:</strong> ${htmlEscape(report.status)}<br>
  ${report.cUnitVerificationFlow ? `<strong>MCP status:</strong> ${htmlEscape(cFlow.artifactGeneration?.mcpStatus || report.status)}<br>` : ""}
  <strong>Run:</strong> ${htmlEscape(report.runId || "unknown")}<br>
  <strong>Diagnostics:</strong> ${diagnosticSummary.total} total, ${diagnosticSummary.blocking} blocking<br>
  <strong>Final answer allowed:</strong> ${htmlEscape(report.finalAnswerAllowed === false ? "no" : "yes")}<br>
  <strong>Next required action:</strong> ${htmlEscape(report.nextRequiredAction || "none")}</p>
  ${linkRows ? `<h2>Review Pages</h2><table><thead><tr><th>Page</th><th>Link</th></tr></thead><tbody>${linkRows}</tbody></table>` : ""}
  ${cCoverageSection}
  ${augmentationSection}
  ${repairPlanSection}
  ${failureSection}
  ${tokenSection}
  <h2>Function Reports</h2>
  <table><thead><tr><th>Symbol</th><th>File</th><th>Verdict</th><th>Coverage</th></tr></thead><tbody>${functionRows}</tbody></table>
  <h2>Diagnostics</h2>
  <table><thead><tr><th>Severity</th><th>Code</th><th>Message</th></tr></thead><tbody>${diagnosticRows}</tbody></table>
</body>
</html>
`;
}

function normalizeAttemptHistory(raw) {
  if (!raw) return { attempts: [], perFunction: [], finalCoverage: null, source: null };
  if (Array.isArray(raw)) return { attempts: raw, perFunction: [], finalCoverage: null, source: null };
  const legacyPerFunction = Array.isArray(raw.perFunctionStopReasons)
    ? raw.perFunctionStopReasons.map((item) => ({
      ...item,
      function: item.function || item.targetFunction || item.symbol,
      attempts: item.attempts || item.attemptHistory || [],
      stopReason: item.stopReason || item.reason || item.status,
      evidence: item.evidence || item.details || item.message
    }))
    : [];
  const perFunction = (Array.isArray(raw.perFunction) ? raw.perFunction : legacyPerFunction)
    .map((item) => ({
      ...item,
      attempts: Array.isArray(item.attempts) ? item.attempts : (Array.isArray(item.attemptHistory) ? item.attemptHistory : [])
    }));
  return {
    attempts: Array.isArray(raw.attempts) ? raw.attempts : (Array.isArray(raw.residualAttempts) ? raw.residualAttempts : (Array.isArray(raw.aggregateAttempts) ? raw.aggregateAttempts : [])),
    perFunction,
    finalCoverage: raw.finalCoverage || raw.bestCodingAgentCoverage || raw.codingAgentAppliedCumulative || raw.coverage || null,
    remainingGaps: normalizeRemainingGaps(raw.remainingGaps || raw.coverageLimits || raw.gaps || []),
    source: raw.source || null
  };
}

function normalizeRemainingGaps(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? { function: null, stopReason: item, evidence: item } : item).filter(Boolean);
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([name, item]) => {
      if (typeof item === "string") return { function: name, stopReason: item, evidence: item };
      return { function: name, ...(item || {}) };
    });
  }
  return [];
}

function classifyStopReason(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (text.includes("crash-risk") || text.includes("crash_risk") || text.includes("access violation") || text.includes("segfault")) return "crash-risk";
  if (text.includes("toolchain-blocked") || text.includes("toolchain_blocked")) return "toolchain-blocked";
  if (text.includes("infeasible") || text.includes("unreachable") || text.includes("tautological")) return "infeasible";
  if (text.includes("max-attempts-reached-with-classified-gaps") || text.includes("classified-gaps") || text.includes("classified_gaps")) return "classified-gaps";
  if (text.includes("max-coverage") || text.includes("max_coverage")) return "max-coverage";
  return null;
}

function stopReasonIsAcceptable(value) {
  return Boolean(classifyStopReason(value));
}

function parseResidualSummaryGaps(text) {
  const gaps = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+`?([A-Za-z_][\w$]*)`?\s*:\s*(.+)$/);
    if (!match) continue;
    const [, functionName, evidence] = match;
    const stopReason = classifyStopReason(evidence);
    if (stopReason) gaps.push({ function: functionName, stopReason, evidence });
  }
  return gaps;
}

function listFilesRecursive(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push({ name: entry.name, fullPath });
      }
    }
  }
  return files;
}

function discoverResidualEvidenceFromArtifacts(outDir) {
  const residualDirs = [
    path.join(outDir, "residual"),
    path.join(outDir, "coding_agent_residual"),
    path.join(outDir, "codex_aug")
  ].filter((dir) => existsSync(dir));
  const attemptsByNumber = new Map();
  for (const dir of residualDirs) {
    for (const entry of listFilesRecursive(dir)) {
      const match = entry.name.match(/^(?:residual_)?attempt(\d+).*\.(c|cc|cpp|exe|json|txt|info|profdata|profraw|log)$/i);
      if (!match) continue;
      const attempt = Number(match[1]);
      if (!Number.isFinite(attempt) || attempt <= 0) continue;
      const fullPath = entry.fullPath;
      const current = attemptsByNumber.get(attempt) || {
        attempt,
        scope: "aggregate",
        function: "__aggregate__",
        changedArtifact: null,
        artifacts: [],
        replayCommand: null
      };
      current.artifacts.push(fullPath);
      if (/\.c$/i.test(entry.name) && !current.changedArtifact) current.changedArtifact = fullPath;
      if (/\.exe$/i.test(entry.name) && !current.replayCommand) current.replayCommand = fullPath;
      attemptsByNumber.set(attempt, current);
    }
  }
  const allAttempts = [...attemptsByNumber.values()].sort((a, b) => a.attempt - b.attempt);
  const isCrashOnlyProbeAttempt = (attempt) => {
    const artifacts = Array.isArray(attempt?.artifacts) ? attempt.artifacts : [];
    if (artifacts.length === 0) return false;
    const names = artifacts.map((artifactPath) => path.basename(String(artifactPath || "")).toLowerCase());
    const tdMainScoped = names.every((name) => name.includes("tdmain") || name.includes("td_main"));
    if (!tdMainScoped) return false;
    const hasCoverageExport = names.some((name) => /\.info$/i.test(name) || /_llvm\.json$/i.test(name));
    if (hasCoverageExport) return false;
    return artifacts.some((artifactPath) => {
      if (!/\.profraw$/i.test(String(artifactPath || ""))) return false;
      try {
        return statSync(artifactPath).size === 0;
      } catch {
        return false;
      }
    });
  };
  const crashOnlyProbeAttempts = allAttempts.filter(isCrashOnlyProbeAttempt);
  const attempts = allAttempts.filter((attempt) => !isCrashOnlyProbeAttempt(attempt));
  const summaryCandidates = [
    path.join(outDir, "mcp_reports", "FINAL_RESIDUAL_SUMMARY.md"),
    path.join(outDir, "FINAL_RESIDUAL_SUMMARY.md"),
    path.join(outDir, "reports", "FINAL_RESIDUAL_SUMMARY.md")
  ];
  const remainingGaps = [];
  const summaryPaths = [];
  for (const candidate of summaryCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, "utf8").replace(/^\uFEFF/, "");
      summaryPaths.push(candidate);
      remainingGaps.push(...parseResidualSummaryGaps(text));
    } catch {
      // Ignore unreadable optional summaries.
    }
  }
  for (const attempt of crashOnlyProbeAttempts) {
    if (!remainingGaps.some((item) => item.function === "TD_main_0_0")) {
      remainingGaps.push({
        function: "TD_main_0_0",
        stopReason: "crash-risk",
        evidence: `Crash-only TD_main_0_0 probe in attempt ${attempt.attempt}; zero-byte profiler output is not a coverage-growth retry attempt.`
      });
    }
  }
  for (const tdProbeDir of residualDirs) {
    try {
      for (const entry of readdirSync(tdProbeDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^(?:tdmain_probe|attempt\d+_tdmain).*\.(?:profraw)$/i.test(entry.name)) continue;
        const fullPath = path.join(tdProbeDir, entry.name);
        const size = statSync(fullPath).size;
        if (size === 0 && !remainingGaps.some((item) => item.function === "TD_main_0_0")) {
          remainingGaps.push({
            function: "TD_main_0_0",
            stopReason: "crash-risk",
            evidence: `Zero-byte profiler output from ${entry.name}; direct TD_main_0_0 probe likely crashed before profile flush.`
          });
        }
      }
    } catch {
      // Ignore optional probe discovery failures.
    }
  }
  return {
    attempts,
    perFunction: [],
    finalCoverage: null,
    remainingGaps,
    source: attempts.length > 0 || remainingGaps.length > 0 ? "discovered-residual-artifacts" : null,
    paths: {
      residualDirs,
      summaryPaths
    }
  };
}

function mergeResidualHistoryWithDiscovered(history, discovered) {
  const merged = {
    ...history,
    attempts: [
      ...(history.attempts || []),
      ...(discovered.attempts || [])
    ],
    perFunction: history.perFunction || [],
    finalCoverage: history.finalCoverage || discovered.finalCoverage || null,
    remainingGaps: [
      ...(history.remainingGaps || []),
      ...(discovered.remainingGaps || [])
    ],
    discovered
  };
  if (!merged.path && discovered.source) merged.path = discovered.source;
  return merged;
}

function loadResidualAttemptHistory(outDir, report) {
  const embedded = report?.codingAgentResidualAttemptHistory || report?.codingAgentResidualRepairPlan?.attemptHistory || null;
  const discovered = discoverResidualEvidenceFromArtifacts(outDir);
  if (embedded) return mergeResidualHistoryWithDiscovered({ ...normalizeAttemptHistory(embedded), path: "embedded-report" }, discovered);
  const candidates = [
    path.join(outDir, "mcp_reports", "coding_agent_residual_attempt_history.json"),
    path.join(outDir, "coding_agent_residual_attempt_history.json"),
    path.join(outDir, "codex_aug", "coding_agent_residual_attempt_history.json"),
    path.join(outDir, "reports", "coding_agent_residual_attempt_history.json")
  ];
  for (const candidate of candidates) {
    const parsed = readJsonWithFallbackSync(candidate, null);
    if (parsed) return mergeResidualHistoryWithDiscovered({ ...normalizeAttemptHistory(parsed), path: candidate }, discovered);
  }
  if ((discovered.attempts || []).length > 0 || (discovered.remainingGaps || []).length > 0) {
    return { ...discovered, path: discovered.source };
  }
  return { attempts: [], perFunction: [], finalCoverage: null, remainingGaps: [], path: null, source: null, discovered };
}

function coverageGoalReached(finalCoverage) {
  if (!finalCoverage || typeof finalCoverage !== "object") return false;
  const metricPercent = (metric) => {
    if (typeof metric === "number") return metric;
    if (typeof metric === "string") {
      const parsed = Number(metric.replace(/%$/, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (!metric || typeof metric !== "object") return null;
    const direct = metric.pct ?? metric.percent ?? metric.percentage;
    if (typeof direct === "number") return direct;
    if (typeof direct === "string") {
      const parsed = Number(direct.replace(/%$/, ""));
      return Number.isFinite(parsed) ? parsed : null;
    }
    const covered = metric.covered ?? metric.hit ?? metric.hits ?? metric.executed ?? metric.taken;
    const total = metric.total ?? metric.count;
    if (typeof covered === "number" && typeof total === "number" && total > 0 && covered >= 0 && covered <= total) return (covered / total) * 100;
    return null;
  };
  const metricReached = (metric, allowZeroTotal = false) => {
    const pct = metricPercent(metric);
    if (typeof pct === "number") return pct >= C_COVERAGE_GOAL_PERCENT;
    const total = metric?.total ?? metric?.count;
    const covered = metric?.covered ?? metric?.hit ?? metric?.hits ?? metric?.executed ?? metric?.taken;
    return allowZeroTotal && typeof total === "number" && total === 0 && (covered === undefined || covered === 0);
  };
  const lineMetric = finalCoverage.line ?? finalCoverage.lines;
  const functionMetric = finalCoverage.function ?? finalCoverage.functions;
  const branchMetric = finalCoverage.branch ?? finalCoverage.branches;
  const branchExecutedMetric = finalCoverage.branchExecuted;
  const branchTakenMetric = finalCoverage.branchTaken;
  const branchReached = branchMetric !== undefined && branchMetric !== null
    ? metricReached(branchMetric, true)
    : ((branchExecutedMetric !== undefined || branchTakenMetric !== undefined)
      && metricReached(branchExecutedMetric, true)
      && metricReached(branchTakenMetric, true));
  const mcdcMetric = finalCoverage.mcdc ?? finalCoverage.mcDc ?? finalCoverage.mc_dc;
  return metricReached(lineMetric, false)
    && branchReached
    && metricReached(functionMetric, false)
    && metricReached(mcdcMetric, true);
}

function evidencePathCandidates(value, outDir) {
  if (!value || typeof value !== "string") return [];
  let normalized = value;
  if (/^file:/i.test(value)) {
    try {
      normalized = fileURLToPath(value);
    } catch {
      normalized = value.replace(/^file:\/\//i, "");
    }
  }
  const insideOutDir = (candidate) => {
    if (!outDir) return true;
    const relative = path.relative(path.resolve(outDir), path.resolve(candidate));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (path.isAbsolute(normalized)) {
    return insideOutDir(normalized) ? [normalized] : [];
  }
  if (!outDir) return [normalized];
  return [
    path.join(outDir, normalized),
    path.join(outDir, "mcp_reports", normalized),
    path.join(outDir, "residual", normalized),
    path.join(outDir, "coding_agent_residual", normalized),
    path.join(outDir, "codex_aug", normalized)
  ].filter(insideOutDir);
}

function evidencePathExists(value, outDir) {
  return evidencePathCandidates(value, outDir).some((candidate) => artifactHasContent(candidate) && artifactRealPathInside(candidate, outDir));
}

function residualActionEvidencePathExists(value, outDir = null) {
  if (typeof value !== "string") return false;
  const name = path.basename(value).toLowerCase();
  const nonActionEvidence = /(?:report|summary|coverage|aggregate)/i.test(name);
  const actionNamed = /(?:residual|attempt|harness|fixture|testcase|input|replay|native_run|asan|ubsan|crash|diagnostic)/i.test(name);
  const looksLikeGeneratedInput = actionNamed && !nonActionEvidence && /\.(?:c|cc|cpp|exe|log|txt)$/i.test(name);
  return looksLikeGeneratedInput && evidencePathExists(value, outDir);
}

function residualAttemptHasEvidence(attempt, outDir = null) {
  if (!attempt || typeof attempt !== "object") return false;
  const directPaths = [
    attempt.changedArtifact,
    attempt.replayCommand,
    attempt.logPath
  ].filter((value) => typeof value === "string");
  if (directPaths.some((value) => residualActionEvidencePathExists(value, outDir))) return true;
  const artifactPaths = (Array.isArray(attempt.artifacts) ? attempt.artifacts : []).filter((value) => typeof value === "string");
  if (artifactPaths.some((value) => residualActionEvidencePathExists(value, outDir))) return true;
  return false;
}

function residualAttemptHasMeasurementEvidence(attempt, outDir = null) {
  if (!attempt || typeof attempt !== "object") return false;
  const explicitPaths = [
    attempt.measurementArtifact,
    attempt.coverageArtifact,
    attempt.reportPath,
    attempt.logPath,
    ...(Array.isArray(attempt.artifacts) ? attempt.artifacts : [])
  ].filter((value) => typeof value === "string");
  if (explicitPaths.some((value) => {
    const name = path.basename(value).toLowerCase();
    return /(?:_llvm\.json|\.info|\.profdata|\.profraw|_report\.txt|_show\.txt|coverage.*\.json)$/i.test(name) && evidencePathExists(value, outDir);
  })) return true;
  return false;
}

function artifactHasContent(artifactPath) {
  try {
    const stat = statSync(artifactPath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function artifactRealPathInside(artifactPath, outDir) {
  if (!outDir) return true;
  try {
    const realArtifact = realpathSync(artifactPath);
    const realOutDir = realpathSync(outDir);
    const relative = path.relative(realOutDir, realArtifact);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function residualAttemptSequenceComplete(attempts, maxAttempts = C_RESIDUAL_MAX_ATTEMPTS) {
  const numbers = new Set((attempts || []).map((item) => Number(item?.attempt)).filter((value) => Number.isFinite(value) && value > 0));
  return Array.from({ length: maxAttempts }, (_, index) => index + 1).every((attempt) => numbers.has(attempt));
}

function residualAttemptEvidenceComplete(attempts, maxAttempts = C_RESIDUAL_MAX_ATTEMPTS, outDir = null) {
  return Array.from({ length: maxAttempts }, (_, index) => index + 1).every((attemptNumber) => {
    const matchingAttempts = (attempts || []).filter((item) => Number(item?.attempt) === attemptNumber);
    return matchingAttempts.some((attempt) => residualAttemptHasEvidence(attempt, outDir) && residualAttemptHasMeasurementEvidence(attempt, outDir));
  });
}

function normalizeResidualMaxAttempts(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : C_RESIDUAL_MAX_ATTEMPTS;
}

function residualTargetName(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return null;
  return item.function || item.targetFunction || item.symbol || item.name || item.target || null;
}

function targetStopIsAcceptable(entry, maxAttempts = C_RESIDUAL_MAX_ATTEMPTS, outDir = null) {
  const attempts = Array.isArray(entry?.attempts) ? entry.attempts : (Array.isArray(entry?.attemptHistory) ? entry.attemptHistory : []);
  const classified = stopReasonIsAcceptable(entry?.stopReason || entry?.status || entry?.evidence);
  const hasAttemptEvidence = attempts.some((attempt) => residualAttemptHasEvidence(attempt, outDir));
  const hasAttemptMeasurementEvidence = attempts.some((attempt) => residualAttemptHasMeasurementEvidence(attempt, outDir));
  const hasEntryEvidencePath = [
    entry?.evidencePath,
    entry?.logPath,
    entry?.artifactPath,
    entry?.changedArtifact
  ].some((value) => residualActionEvidencePathExists(value, outDir));
  return classified
    ? (hasAttemptEvidence || hasEntryEvidencePath)
    : ((entry?.goalReached === true || entry?.coverageGoalReached === true) && hasAttemptEvidence && hasAttemptMeasurementEvidence)
      || (attempts.length >= maxAttempts && residualAttemptSequenceComplete(attempts, maxAttempts) && residualAttemptEvidenceComplete(attempts, maxAttempts, outDir));
}

function clearFinalBlockingAction(action, message) {
  const base = action && typeof action === "object" && !Array.isArray(action) ? action : {};
  return {
    ...base,
    required: false,
    completionBlocked: false,
    finalAnswerAllowed: true,
    nextRequiredAction: null,
    reason: "Final evidence gate passed.",
    message,
    targetCount: 0,
    requiredEvidence: []
  };
}

function buildCFinalEvidenceGate({ report, outDir }) {
  const action = report?.actionRequired || report?.codingAgentResidualActionRequired || {};
  const residualPlan = report?.codingAgentResidualRepairPlan || {};
  const history = loadResidualAttemptHistory(outDir, report);
  const reportFinalCoverage = report?.finalCoverage
    || report?.coverage
    || report?.coverageSummary
    || report?.residualCoverage?.finalCoverage
    || null;
  const measuredFinalCoverage = history.finalCoverage || reportFinalCoverage;
  const rawGoalReached = coverageGoalReached(measuredFinalCoverage);
  const residualEvidenceRequired = Boolean(action.required || residualPlan.executionRequired || report?.completionBlocked || report?.finalAnswerAllowed === false);
  const required = residualEvidenceRequired || !rawGoalReached;
  const targetNames = (residualPlan.targets || report?.residualTargets || [])
    .map(residualTargetName)
    .filter(Boolean);
  const perFunction = history.perFunction || [];
  const attempts = history.attempts || [];
  const remainingGaps = history.remainingGaps || [];
  const maxAttemptsPerFunction = normalizeResidualMaxAttempts(residualPlan.attemptAccounting?.maxAttemptsPerFunction);
  const classifiedRemainingGaps = remainingGaps.filter((item) => stopReasonIsAcceptable(item.stopReason || item.reason || item.status || item.evidence));
  const classifiedTargetNames = new Set(classifiedRemainingGaps
    .map(residualTargetName)
    .filter(Boolean));
  const aggregateAttemptNumbers = new Set(attempts.map((item) => Number(item.attempt)).filter((value) => Number.isFinite(value) && value > 0));
  const aggregateAttemptCount = aggregateAttemptNumbers.size || attempts.length;
  const aggregateAttemptSequenceComplete = Array.from({ length: maxAttemptsPerFunction }, (_, index) => index + 1)
    .every((attempt) => aggregateAttemptNumbers.has(attempt));
  const aggregateAttemptEvidenceComplete = residualAttemptEvidenceComplete(attempts, maxAttemptsPerFunction, outDir);
  const hasResidualAttemptEvidence = attempts.some((attempt) => residualAttemptHasEvidence(attempt, outDir));
  const hasResidualMeasurementEvidence = attempts.some((attempt) => residualAttemptHasMeasurementEvidence(attempt, outDir));
  const hasPerFunctionEvidence = perFunction.some((entry) => targetStopIsAcceptable(entry, maxAttemptsPerFunction, outDir));
  const finalCoverageEvidenceComplete = rawGoalReached && (!residualEvidenceRequired || (hasResidualAttemptEvidence && hasResidualMeasurementEvidence) || hasPerFunctionEvidence);
  const goalReached = rawGoalReached && finalCoverageEvidenceComplete;
  const allTargetsClassified = targetNames.length > 0 && targetNames.every((name) => classifiedTargetNames.has(name));
  const aggregateEvidenceSatisfied = targetNames.length > 0
    && aggregateAttemptCount >= maxAttemptsPerFunction
    && aggregateAttemptSequenceComplete
    && aggregateAttemptEvidenceComplete
    && allTargetsClassified;
  const coveredTargets = new Set([
    ...attempts.map(residualTargetName).filter(Boolean),
    ...perFunction.map(residualTargetName).filter(Boolean),
    ...classifiedTargetNames
  ]);
  const missingTargets = aggregateEvidenceSatisfied ? [] : targetNames.filter((name) => !coveredTargets.has(name));
  const incompleteTargets = aggregateEvidenceSatisfied
    ? []
    : perFunction
      .filter((item) => !targetStopIsAcceptable(item, maxAttemptsPerFunction, outDir))
      .map((item) => residualTargetName(item) || "unknown");
  const blockers = [];
  if (required && !history.path && attempts.length === 0 && perFunction.length === 0) blockers.push("missing_residual_attempt_history");
  if (required && !goalReached && targetNames.length === 0) blockers.push("residual_targets_missing");
  if (required && !goalReached && !aggregateEvidenceSatisfied && aggregateAttemptCount < maxAttemptsPerFunction && perFunction.length === 0) {
    blockers.push("aggregate_residual_attempts_below_required");
  }
  if (required && !goalReached && aggregateAttemptCount >= maxAttemptsPerFunction && !aggregateAttemptSequenceComplete && perFunction.length === 0) {
    blockers.push("aggregate_residual_attempt_sequence_incomplete");
  }
  if (required && !goalReached && aggregateAttemptSequenceComplete && !aggregateAttemptEvidenceComplete && perFunction.length === 0) {
    blockers.push("aggregate_residual_attempt_evidence_incomplete");
  }
  if (required && rawGoalReached && !finalCoverageEvidenceComplete) {
    blockers.push("final_coverage_evidence_missing");
  }
  if (required && !goalReached && targetNames.length > 0 && missingTargets.length > 0) blockers.push("residual_targets_without_attempt_history");
  if (required && !goalReached && incompleteTargets.length > 0) blockers.push("residual_targets_without_max_attempt_or_stop_reason");
  const staleReportState = required && report?.finalAnswerAllowed === false && blockers.length === 0;
  return {
    schemaVersion: "perfectone.c.final-evidence-gate.v1",
    status: blockers.length > 0 ? "blocked" : "passed",
    required,
    finalAnswerAllowed: blockers.length === 0,
    completionBlocked: blockers.length > 0,
    nextRequiredAction: blockers.length > 0 ? "execute_coding_agent_residual_repair_loop" : null,
    blockers,
    requiredTargets: targetNames,
    missingTargets,
    incompleteTargets,
    attemptHistoryPath: history.path,
    attemptCount: attempts.length,
    perFunctionCount: perFunction.length,
    aggregateAttemptCount,
    aggregateAttemptSequenceComplete,
    aggregateAttemptEvidenceComplete,
    aggregateEvidenceSatisfied,
    classifiedRemainingGapCount: classifiedRemainingGaps.length,
    finalCoverageGoalReached: goalReached,
    rawFinalCoverageGoalReached: rawGoalReached,
    finalCoverageEvidenceComplete,
    hasResidualAttemptEvidence,
    hasResidualMeasurementEvidence,
    hasPerFunctionEvidence,
    staleReportState,
    maxAttemptsPerFunction,
    requiredEvidence: action.requiredEvidence || [],
    message: blockers.length > 0
      ? "Final verification reporting is blocked until Coding Agent residual repair evidence is recorded for the 100% coverage goal."
      : "Final evidence gate passed."
  };
}

function renderFinalEvidenceGateMarkdown(gate) {
  return [
    "# Final Report Blocked",
    "",
    gate.message,
    "",
    `- status: ${gate.status}`,
    `- finalAnswerAllowed: ${gate.finalAnswerAllowed}`,
    `- completionBlocked: ${gate.completionBlocked}`,
    `- nextRequiredAction: ${gate.nextRequiredAction || "none"}`,
    `- blockers: ${(gate.blockers || []).join(", ") || "none"}`,
    `- attemptHistoryPath: ${gate.attemptHistoryPath || "missing"}`,
    `- attemptCount: ${gate.attemptCount}`,
    `- perFunctionCount: ${gate.perFunctionCount}`,
    `- maxAttemptsPerFunction: ${gate.maxAttemptsPerFunction}`,
    "",
    "## Missing Targets",
    "",
    ...((gate.missingTargets || []).map((name) => `- ${name}`)),
    "",
    "## Required Evidence",
    "",
    ...((gate.requiredEvidence || []).map((item) => `- ${item}`))
  ].join("\n");
}

function applyPassedFinalEvidenceGateToReport(report, gate) {
  const normalized = { ...report };
  normalized.status = normalized.status === "needs_coding_agent_residual" || normalized.status === "needs_coding_agent_augmentation"
    ? "completed_with_coding_agent_residual"
    : (normalized.status || "completed_with_coding_agent_residual");
  normalized.mcpStatus = normalized.mcpStatus === "needs_coding_agent_residual" || normalized.mcpStatus === "needs_coding_agent_augmentation"
    ? "completed_with_coding_agent_residual"
    : (normalized.mcpStatus || normalized.status);
  normalized.completionBlocked = false;
  normalized.finalAnswerAllowed = true;
  normalized.nextRequiredAction = null;
  normalized.finalEvidenceGate = gate;
  if (normalized.actionRequired) {
    normalized.actionRequired = clearFinalBlockingAction(
      normalized.actionRequired,
      "Final evidence gate passed. No further action is required before the final answer."
    );
  }
  if (normalized.codingAgentResidualActionRequired) {
    normalized.codingAgentResidualActionRequired = clearFinalBlockingAction(
      normalized.codingAgentResidualActionRequired,
      "Coding-agent residual evidence satisfied the final evidence gate. No further residual repair is required before the final answer."
    );
  }
  if (normalized.codingAgentTestAugmentationActionRequired) {
    normalized.codingAgentTestAugmentationActionRequired = clearFinalBlockingAction(
      normalized.codingAgentTestAugmentationActionRequired,
      "Coding-agent testcase augmentation evidence satisfied the final evidence gate. No further testcase augmentation is required before the final answer."
    );
  }
  if (normalized.codingAgentResidualRepairPlan) {
    normalized.codingAgentResidualRepairPlan = {
      ...normalized.codingAgentResidualRepairPlan,
      executionRequired: false,
      nextRequiredAction: null,
      attemptHistory: gate.attemptHistoryPath || normalized.codingAgentResidualRepairPlan.attemptHistory || null,
      message: "Residual repair attempt history satisfied the final evidence gate."
    };
  }
  if (normalized.codingAgentTestAugmentationPlan) {
    normalized.codingAgentTestAugmentationPlan = {
      ...normalized.codingAgentTestAugmentationPlan,
      executionRequired: false,
      nextRequiredAction: null,
      message: "Test augmentation evidence satisfied the final evidence gate."
    };
  }
  for (const promptKey of ["codingPlatformPrompt", "codingAgentResidualRepairPrompt", "codingAgentTestAugmentationPrompt"]) {
    if (Object.prototype.hasOwnProperty.call(normalized, promptKey)) delete normalized[promptKey];
  }
  return normalized;
}

async function writeReportBundle(outDir, report, diagnosticSummary, options = {}) {
  const generated = [];
  try {
    if (!Array.isArray(report.diagnostics)) report.diagnostics = [];
    const reportDir = path.join(outDir, "mcp_reports");
    const reportBaseName = options.reportBaseName || "perfectone_mcp_report";
    const isCanonicalReport = reportBaseName === "perfectone_mcp_report";
    const functionDir = path.join(reportDir, isCanonicalReport ? "functions" : reportBaseName, "functions");
    await mkdir(functionDir, { recursive: true });
    const jsonPath = path.join(reportDir, `${reportBaseName}.json`);
    const mdPath = path.join(reportDir, `${reportBaseName}.md`);
    const htmlPath = path.join(reportDir, `${reportBaseName}.html`);
    const sanitizedReport = sanitizeJsonValue(report);
    await writeFile(jsonPath, JSON.stringify(sanitizedReport, null, 2), "utf8");
    let mdText = "";
    try {
      mdText = renderMarkdownReport(report, diagnosticSummary);
    } catch (error) {
      pushDiagnostic(report.diagnostics, {
        severity: "warning",
        code: "markdown_report_render_failed",
        message: `Markdown report renderer fell back to diagnostic Markdown: ${String(error)}`,
        source: "mcp"
      });
      mdText = [
        "# PerfectOne Unit Verify Report",
        "",
        `- status: ${report.status || "unknown"}`,
        `- runId: ${report.runId || "unknown"}`,
        `- final answer allowed: ${report.finalAnswerAllowed === false ? "no" : "yes"}`,
        `- next required action: ${report.nextRequiredAction || "none"}`,
        "",
        "## Diagnostic Report",
        "",
        "The full Markdown renderer failed, but this fallback report was regenerated from the current MCP JSON state."
      ].join("\n");
    }
    await writeFile(mdPath, mdText, "utf8");
    let htmlText = "";
    try {
      htmlText = renderHtmlReport(report, diagnosticSummary);
    } catch (error) {
      pushDiagnostic(report.diagnostics, {
        severity: "warning",
        code: "html_report_render_failed",
        message: `HTML report renderer fell back to diagnostic HTML: ${String(error)}`,
        source: "mcp"
      });
      htmlText = renderSimpleHtmlPage({
        title: "PerfectOne Unit Verify Report",
        body: [
          `<p><strong>Status:</strong> ${htmlEscape(report.status)}<br><strong>Run:</strong> ${htmlEscape(report.runId || "unknown")}<br><strong>Final answer allowed:</strong> ${htmlEscape(report.finalAnswerAllowed === false ? "no" : "yes")}<br><strong>Next required action:</strong> ${htmlEscape(report.nextRequiredAction || "none")}</p>`,
          "<h2>Review Pages</h2>",
          "<h2>C Coverage Flow</h2>",
          "<h2>Residual Loop Policy</h2>",
          "<h2>Coding Agent Residual Targets</h2>",
          "<h2>Coding Agent Additional Test Augmentation</h2>",
          "<h2>Coding Agent Residual Repair Plan</h2>",
          "<h2>Coverage Cumulative</h2>",
          "<p>PerfectOne Coverage / Coding Agent Applied Cumulative / Coding Agent Increase</p>",
          "<h2>Failure Evidence and Replay</h2>",
          "<h2>Token Usage</h2>",
          `<pre>${htmlEscape(JSON.stringify(report, null, 2))}</pre>`
        ].join("\n")
      });
    }
    await writeFile(htmlPath, htmlText, "utf8");
    generated.push(artifactEntry(jsonPath, outDir, "aggregate-report"));
    generated.push(artifactEntry(mdPath, outDir, "aggregate-report"));
    generated.push(artifactEntry(htmlPath, outDir, "aggregate-report"));
    if (report.finalAnswerAllowed === true && report.completionBlocked === false) {
      const staleBlockedPath = path.join(reportDir, isCanonicalReport ? "FINAL_REPORT_BLOCKED.md" : `${reportBaseName}_FINAL_REPORT_BLOCKED.md`);
      if (existsSync(staleBlockedPath)) unlinkSync(staleBlockedPath);
    }
    if (report.failureEvidence) {
      const failurePath = path.join(reportDir, isCanonicalReport ? "failure_evidence.json" : `${reportBaseName}_failure_evidence.json`);
      await writeFile(failurePath, JSON.stringify(report.failureEvidence, null, 2), "utf8");
      generated.push(artifactEntry(failurePath, outDir, "failure-evidence"));
    }
    if (report.tokenUsage) {
      const tokenPath = path.join(reportDir, isCanonicalReport ? "token_usage.json" : `${reportBaseName}_token_usage.json`);
      await writeFile(tokenPath, JSON.stringify(report.tokenUsage, null, 2), "utf8");
      generated.push(artifactEntry(tokenPath, outDir, "token-usage"));
    }
    if (report.codingAgentResidualActionRequired?.required) {
      const gate = buildCFinalEvidenceGate({ report, outDir });
      const gatePath = path.join(reportDir, isCanonicalReport ? "final_evidence_gate.json" : `${reportBaseName}_final_evidence_gate.json`);
      await writeFile(gatePath, JSON.stringify(sanitizeJsonValue(gate), null, 2), "utf8");
      generated.push(artifactEntry(gatePath, outDir, "final-evidence-gate"));
      if (gate.status === "blocked") {
        const blockedPath = path.join(reportDir, isCanonicalReport ? "FINAL_REPORT_BLOCKED.md" : `${reportBaseName}_FINAL_REPORT_BLOCKED.md`);
        await writeFile(blockedPath, renderFinalEvidenceGateMarkdown(gate), "utf8");
        generated.push(artifactEntry(blockedPath, outDir, "final-report-blocker"));
      }
      const residualPath = path.join(reportDir, isCanonicalReport ? "coding_agent_residual_required.md" : `${reportBaseName}_coding_agent_residual_required.md`);
      const action = report.codingAgentResidualActionRequired;
      const residualDoc = [
        "# Coding Agent Residual Repair Required",
        "",
        action.message,
        "",
        `- finalAnswerAllowed: ${action.finalAnswerAllowed}`,
        `- completionBlocked: ${action.completionBlocked}`,
        `- nextRequiredAction: ${action.nextRequiredAction}`,
        `- targetCount: ${action.targetCount}`,
        `- maxAttemptsPerFunction: ${action.maxAttemptsPerFunction}`,
        "",
        "## Prohibited Shortcuts",
        "",
        ...(action.prohibitedShortcuts || []).map((item) => `- ${item}`),
        "",
        "## Required Evidence",
        "",
        ...(action.requiredEvidence || []).map((item) => `- ${item}`),
        "",
        "## Prompt",
        "",
        report.codingAgentResidualRepairPrompt || report.codingPlatformPrompt || ""
      ].join("\n");
      await writeFile(residualPath, residualDoc, "utf8");
      generated.push(artifactEntry(residualPath, outDir, "coding-agent-residual-required"));
    }
    if (report.codingAgentTestAugmentationActionRequired?.required) {
      const augmentationPath = path.join(reportDir, isCanonicalReport ? "coding_agent_test_augmentation_required.md" : `${reportBaseName}_coding_agent_test_augmentation_required.md`);
      const action = report.codingAgentTestAugmentationActionRequired;
      const augmentationDoc = [
        "# Coding Agent Test Augmentation Required",
        "",
        action.message,
        "",
        `- finalAnswerAllowed: ${action.finalAnswerAllowed}`,
        `- completionBlocked: ${action.completionBlocked}`,
        `- nextRequiredAction: ${action.nextRequiredAction}`,
        "",
        "## Always Execute For Code-Only Verification",
        "",
        ...(action.codeOnlyAlwaysExecute || []).map((item) => `- ${item}`),
        "",
        "## Conditional",
        "",
        ...(action.conditionalExecute || []).map((item) => `- ${item}`),
        "",
        "## Specification-Driven When Provided",
        "",
        ...(action.specificationDrivenRequiredWhenProvided || []).map((item) => `- ${item}`),
        "",
        "## Required Evidence",
        "",
        ...(action.requiredEvidence || []).map((item) => `- ${item}`)
      ].join("\n");
      await writeFile(augmentationPath, augmentationDoc, "utf8");
      generated.push(artifactEntry(augmentationPath, outDir, "coding-agent-test-augmentation-required"));
    }
    for (const functionReport of report.functionReports || []) {
      const filePath = path.join(functionDir, `${slug(functionReport.symbol)}.json`);
      await writeFile(filePath, JSON.stringify(functionReport, null, 2), "utf8");
      generated.push(artifactEntry(filePath, outDir, "function-report"));
    }
  } catch (error) {
    pushDiagnostic(report.diagnostics, {
      severity: "warning",
      code: "report_render_failed",
      message: `MCP report rendering failed: ${String(error)}`,
      source: "mcp"
    });
  }
  return generated;
}

function schemaPathForVersion(schemaVersion) {
  const schemaFile = UNIT_DESIGN_SCHEMA_FILES[schemaVersion];
  return schemaFile ? path.join(schemasRoot, schemaFile) : null;
}

function parseMaybeJson(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function reviewStatusOf(item) {
  return item?.reviewStatus || item?.status || item?.review?.status || null;
}

function validateReviewStatus(item, pathLabel, errors, warnings) {
  const status = reviewStatusOf(item);
  if (!status) {
    warnings.push({ path: pathLabel, code: "review_status_missing", message: "Review status is missing." });
    return;
  }
  if (!REVIEW_STATUSES.has(status)) {
    errors.push({ path: pathLabel, code: "invalid_review_status", message: `Review status '${status}' is not supported.` });
  }
}

function requireArray(artifact, key, errors) {
  if (!Array.isArray(artifact[key])) {
    errors.push({ path: key, code: "required_array_missing", message: `${key} must be an array.` });
    return [];
  }
  return artifact[key];
}

function countByStatus(rows) {
  const counts = {};
  for (const row of rows || []) {
    const status = reviewStatusOf(row) || "unspecified";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function validateUnitDesignArtifact(artifact) {
  const errors = [];
  const warnings = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return {
      valid: false,
      schemaVersion: null,
      schemaPath: null,
      errors: [{ path: "$", code: "artifact_not_object", message: "Artifact must be a JSON object." }],
      warnings: [],
      summary: {}
    };
  }

  const schemaVersion = artifact.schemaVersion;
  const schemaPath = schemaPathForVersion(schemaVersion);
  if (!schemaVersion) {
    errors.push({ path: "schemaVersion", code: "schema_version_missing", message: "schemaVersion is required." });
  } else if (!schemaPath) {
    errors.push({ path: "schemaVersion", code: "unsupported_schema_version", message: `Unsupported schemaVersion '${schemaVersion}'.` });
  }

  const summary = { counts: {}, reviewStatus: {} };
  if (schemaVersion === "unitverify.spec-analysis.v1") {
    const requirements = requireArray(artifact, "requirements", errors);
    const units = Array.isArray(artifact.units) ? artifact.units : [];
    summary.counts = { requirements: requirements.length, units: units.length };
    for (const [index, item] of requirements.entries()) validateReviewStatus(item, `requirements[${index}]`, errors, warnings);
    for (const [index, item] of units.entries()) validateReviewStatus(item, `units[${index}]`, errors, warnings);
    summary.reviewStatus = countByStatus([...requirements, ...units]);
  } else if (schemaVersion === "unitverify.test-design.v1") {
    const testCases = requireArray(artifact, "testCases", errors);
    const manualTestCases = Array.isArray(artifact.manualTestCases) ? artifact.manualTestCases : [];
    const decisionTables = Array.isArray(artifact.decisionTables) ? artifact.decisionTables : [];
    const stateModels = Array.isArray(artifact.stateModels) ? artifact.stateModels : [];
    const boundaryValues = Array.isArray(artifact.boundaryValues) ? artifact.boundaryValues : [];
    const equivalencePartitions = Array.isArray(artifact.equivalencePartitions) ? artifact.equivalencePartitions : [];
    const undefinedBehaviorCorners = Array.isArray(artifact.undefinedBehaviorCorners) ? artifact.undefinedBehaviorCorners : [];
    const abnormalBehaviorCorners = Array.isArray(artifact.abnormalBehaviorCorners) ? artifact.abnormalBehaviorCorners : [];
    const testTechniqueSummary = Array.isArray(artifact.testTechniqueSummary) ? artifact.testTechniqueSummary : [];
    summary.counts = {
      testCases: testCases.length,
      manualTestCases: manualTestCases.length,
      decisionTables: decisionTables.length,
      stateModels: stateModels.length,
      boundaryValues: boundaryValues.length,
      equivalencePartitions: equivalencePartitions.length,
      undefinedBehaviorCorners: undefinedBehaviorCorners.length,
      abnormalBehaviorCorners: abnormalBehaviorCorners.length,
      testTechniqueSummary: testTechniqueSummary.length
    };
    const reviewRows = [...testCases, ...manualTestCases, ...decisionTables, ...stateModels, ...boundaryValues, ...equivalencePartitions, ...undefinedBehaviorCorners, ...abnormalBehaviorCorners];
    for (const [index, item] of reviewRows.entries()) validateReviewStatus(item, `reviewItems[${index}]`, errors, warnings);
    summary.reviewStatus = countByStatus(reviewRows);
  } else if (schemaVersion === "unitverify.assertion.v1") {
    const assertions = requireArray(artifact, "assertions", errors);
    summary.counts = { assertions: assertions.length };
    for (const [index, item] of assertions.entries()) validateReviewStatus(item, `assertions[${index}]`, errors, warnings);
    summary.reviewStatus = countByStatus(assertions);
  } else if (schemaVersion === "unitverify.oracle.v1") {
    const oracles = requireArray(artifact, "oracles", errors);
    summary.counts = { oracles: oracles.length };
    for (const [index, item] of oracles.entries()) validateReviewStatus(item, `oracles[${index}]`, errors, warnings);
    summary.reviewStatus = countByStatus(oracles);
  } else if (schemaVersion === "unitverify.traceability.v1") {
    const links = requireArray(artifact, "links", errors);
    summary.counts = { links: links.length };
  } else if (schemaVersion === "unitverify.review.v1") {
    const items = requireArray(artifact, "items", errors);
    summary.counts = { items: items.length };
    for (const [index, item] of items.entries()) validateReviewStatus(item, `items[${index}]`, errors, warnings);
    summary.reviewStatus = countByStatus(items);
  }

  return { valid: errors.length === 0, schemaVersion, schemaPath, errors, warnings, summary };
}

async function readJsonArtifact(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function loadArtifacts(args) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const artifacts = [];
  for (const artifact of args.artifacts || []) {
    artifacts.push({ artifact, path: null });
  }
  for (const artifactPathValue of args.artifactPaths || []) {
    const artifactPathResolved = path.resolve(projectRoot, artifactPathValue);
    artifacts.push({ artifact: await readJsonArtifact(artifactPathResolved), path: artifactPathResolved });
  }
  if (args.artifact) artifacts.push({ artifact: args.artifact, path: null });
  if (args.artifactPath) {
    const artifactPathResolved = path.resolve(projectRoot, args.artifactPath);
    artifacts.push({ artifact: await readJsonArtifact(artifactPathResolved), path: artifactPathResolved });
  }
  return { projectRoot, artifacts };
}

function reviewRowsForArtifact(artifact, sourcePath = null) {
  const version = artifact?.schemaVersion || "unknown";
  const rows = [];
  const pushRows = (kind, list) => {
    for (const item of list || []) {
      rows.push({
        schemaVersion: version,
        kind,
        id: item.requirementId || item.unitId || item.testcaseId || item.caseId || item.assertionId || item.oracleId || item.linkId || item.id || "",
        unitId: item.unitId || item.targetUnitId || "",
        requirementId: item.requirementId || "",
        title: item.title || item.name || item.summary || item.technique || item.riskType || item.expression || item.text || "",
        reviewStatus: reviewStatusOf(item) || "unspecified",
        confidence: item.confidence ?? "",
        evidence: item.evidence || item.applicationReason || item.designReason || item.sourceRef || item.source || "",
        sourcePath
      });
    }
  };
  pushRows("requirement", artifact.requirements);
  pushRows("unit", artifact.units);
  pushRows("testcase", artifact.testCases);
  pushRows("manual-testcase", artifact.manualTestCases);
  pushRows("decision-table", artifact.decisionTables);
  pushRows("state-model", artifact.stateModels);
  pushRows("boundary-value", artifact.boundaryValues);
  pushRows("equivalence-partition", artifact.equivalencePartitions);
  pushRows("ub-corner-case", artifact.undefinedBehaviorCorners);
  pushRows("abnormal-behavior-corner-case", artifact.abnormalBehaviorCorners);
  pushRows("test-technique-summary", artifact.testTechniqueSummary);
  pushRows("assertion", artifact.assertions);
  pushRows("oracle", artifact.oracles);
  pushRows("traceability", artifact.links);
  pushRows("review", artifact.items);
  return rows;
}

function renderUnitDesignReviewHtml({ title, artifacts, validations }) {
  const rows = artifacts.flatMap((entry) => reviewRowsForArtifact(entry.artifact, entry.path));
  const statusCounts = countByStatus(rows);
  const artifactRows = artifacts
    .map((entry, index) => {
      const validation = validations[index] || {};
      return `<tr><td>${htmlEscape(entry.artifact?.schemaVersion || "unknown")}</td><td>${htmlEscape(entry.path || "inline")}</td><td>${htmlEscape(validation.valid ? "valid" : "invalid")}</td><td>${htmlEscape(JSON.stringify(validation.summary?.counts || {}))}</td></tr>`;
    })
    .join("\n");
  const reviewRows = rows
    .map((row) => {
      const attention = ["missing", "needs_review", "unspecified"].includes(row.reviewStatus) ? " class=\"attention\"" : "";
      return `<tr${attention}><td>${htmlEscape(row.kind)}</td><td>${htmlEscape(row.id)}</td><td>${htmlEscape(row.requirementId)}</td><td>${htmlEscape(row.unitId)}</td><td>${htmlEscape(row.reviewStatus)}</td><td>${htmlEscape(row.confidence)}</td><td>${htmlEscape(row.title)}</td><td>${htmlEscape(row.evidence)}</td></tr>`;
    })
    .join("\n");
  const validationRows = validations
    .flatMap((validation, index) => [...(validation.errors || []), ...(validation.warnings || [])].map((item) => ({ ...item, artifact: artifacts[index]?.path || artifacts[index]?.artifact?.schemaVersion || "inline" })))
    .map((item) => `<tr><td>${htmlEscape(item.artifact)}</td><td>${htmlEscape(item.code)}</td><td>${htmlEscape(item.path)}</td><td>${htmlEscape(item.message)}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${htmlEscape(title || "Unit Design Review")}</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 32px; color: #111827; background: #f9fafb; }
    main { max-width: 1200px; margin: 0 auto; }
    h1, h2 { margin: 0 0 12px; }
    section { background: #fff; border: 1px solid #d1d5db; border-radius: 8px; padding: 18px; margin: 16px 0; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .metric { border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; background: #f3f4f6; }
    .metric strong { display: block; font-size: 22px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; background: #fff; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #eef2ff; }
    .attention td { background: #fff7ed; }
    code { background: #f3f4f6; padding: 2px 4px; }
  </style>
</head>
<body>
<main>
  <h1>${htmlEscape(title || "Unit Design Review")}</h1>
  <section>
    <h2>Review Status</h2>
    <div class="metrics">
      ${Object.entries(statusCounts).map(([key, value]) => `<div class="metric"><span>${htmlEscape(key)}</span><strong>${htmlEscape(value)}</strong></div>`).join("\n")}
    </div>
  </section>
  <section>
    <h2>Artifacts</h2>
    <table><thead><tr><th>Schema</th><th>Path</th><th>Validation</th><th>Counts</th></tr></thead><tbody>${artifactRows}</tbody></table>
  </section>
  <section>
    <h2>Review Items</h2>
    <table><thead><tr><th>Kind</th><th>ID</th><th>Requirement</th><th>Unit</th><th>Status</th><th>Confidence</th><th>Title</th><th>Evidence</th></tr></thead><tbody>${reviewRows}</tbody></table>
  </section>
  <section>
    <h2>Validation Diagnostics</h2>
    <table><thead><tr><th>Artifact</th><th>Code</th><th>Path</th><th>Message</th></tr></thead><tbody>${validationRows}</tbody></table>
  </section>
</main>
</body>
</html>
`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let index = 0; index < String(text || "").length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  row.push(value);
  if (row.some((cell) => cell !== "")) rows.push(row);
  if (rows.length === 0) return [];
  const headers = rows[0].map((cell) => cell.trim());
  return rows.slice(1).map((cells) => {
    const item = {};
    for (const [index, header] of headers.entries()) item[header] = cells[index] ?? "";
    return item;
  });
}

function csvEscape(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function formatCsv(rows, headers) {
  return [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header] ?? "")).join(","))
  ].join("\r\n") + "\r\n";
}

async function validateArtifactTool(args) {
  const { artifacts } = await loadArtifacts(args);
  const validations = artifacts.map((entry) => validateUnitDesignArtifact(entry.artifact));
  return {
    status: validations.every((item) => item.valid) ? "passed" : "failed",
    artifactCount: artifacts.length,
    validations
  };
}

async function renderReviewHtmlTool(args) {
  const { projectRoot, artifacts } = await loadArtifacts(args);
  const validations = artifacts.map((entry) => validateUnitDesignArtifact(entry.artifact));
  const outFile = path.resolve(projectRoot, args.outFile || path.join(".perfectone", "unit-design", "review.html"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, renderUnitDesignReviewHtml({ title: args.title, artifacts, validations }), "utf8");
  return {
    status: validations.every((item) => item.valid) ? "passed" : "review_needed",
    outFile,
    artifactCount: artifacts.length,
    validations
  };
}

async function importManualTestsTool(args) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const csvText = args.csvText ?? (args.inputPath ? await readFile(path.resolve(projectRoot, args.inputPath), "utf8") : "");
  const rows = parseCsv(csvText);
  const now = new Date().toISOString();
  const manualTestCases = rows.map((row, index) => ({
    testcaseId: row.testcaseId || row.id || `manual-${String(index + 1).padStart(3, "0")}`,
    requirementId: row.requirementId || row.reqId || "",
    unitId: row.unitId || row.function || row.symbol || "",
    name: row.name || row.title || `Manual testcase ${index + 1}`,
    designMethod: "manual",
    inputs: parseMaybeJson(row.inputs, row.inputs || {}),
    oracleRef: row.oracleRef || row.oracleId || "",
    expected: parseMaybeJson(row.expected, row.expected || {}),
    reviewStatus: row.reviewStatus || row.status || "needs_review",
    source: row.source || "manual",
    evidence: row.evidence || "",
    createdAt: now
  }));
  const artifact = {
    schemaVersion: "unitverify.test-design.v1",
    designId: args.designId || `manual-tests-${Date.now()}`,
    language: args.language || "unknown",
    source: { kind: "manual-import", path: args.inputPath || null },
    testCases: manualTestCases,
    manualTestCases,
    decisionTables: [],
    stateModels: [],
    boundaryValues: [],
    equivalencePartitions: [],
    createdAt: now
  };
  const validation = validateUnitDesignArtifact(artifact);
  const outFile = path.resolve(projectRoot, args.outFile || path.join(".perfectone", "unit-design", "manual-testcases.json"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(artifact, null, 2), "utf8");
  return { status: validation.valid ? "passed" : "failed", outFile, imported: manualTestCases.length, validation, artifact };
}

async function exportManualTestsTool(args) {
  const { projectRoot, artifacts } = await loadArtifacts(args);
  const artifact = artifacts[0]?.artifact || {};
  const rows = [...(artifact.manualTestCases || []), ...(artifact.testCases || []).filter((item) => item.designMethod === "manual")];
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    const key = row.testcaseId || row.id || JSON.stringify(row);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }
  const headers = ["testcaseId", "requirementId", "unitId", "name", "inputs", "expected", "oracleRef", "reviewStatus", "source", "evidence"];
  const csvRows = unique.map((row) => ({
    testcaseId: row.testcaseId || row.id || "",
    requirementId: row.requirementId || "",
    unitId: row.unitId || "",
    name: row.name || row.title || "",
    inputs: row.inputs ?? {},
    expected: row.expected ?? {},
    oracleRef: row.oracleRef || row.oracleId || "",
    reviewStatus: reviewStatusOf(row) || "",
    source: row.source || "",
    evidence: row.evidence || ""
  }));
  const outFile = path.resolve(projectRoot, args.outFile || path.join(".perfectone", "unit-design", "manual-testcases.csv"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, formatCsv(csvRows, headers), "utf8");
  return { status: "passed", outFile, exported: csvRows.length };
}

function valuesEqual(expected, actual, tolerance = null) {
  if (typeof expected === "number" && typeof actual === "number" && typeof tolerance === "number") {
    return Math.abs(expected - actual) <= tolerance;
  }
  return JSON.stringify(expected) === JSON.stringify(actual);
}

async function compareExpectedValuesTool(args) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const oracleArtifact = args.oracleArtifact || (args.oraclePath ? await readJsonArtifact(path.resolve(projectRoot, args.oraclePath)) : { schemaVersion: "unitverify.oracle.v1", oracles: [] });
  const actualArtifact = args.actuals || (args.actualPath ? await readJsonArtifact(path.resolve(projectRoot, args.actualPath)) : []);
  const actualRows = Array.isArray(actualArtifact) ? actualArtifact : actualArtifact.results || actualArtifact.actuals || [];
  const actualByKey = new Map();
  for (const actual of actualRows) {
    for (const key of [actual.oracleId, actual.testcaseId, actual.caseId, actual.id].filter(Boolean)) actualByKey.set(key, actual);
  }
  const results = (oracleArtifact.oracles || []).map((oracle) => {
    const actual = actualByKey.get(oracle.oracleId) || actualByKey.get(oracle.testcaseId) || actualByKey.get(oracle.caseId) || null;
    const tolerance = typeof oracle.tolerance === "number" ? oracle.tolerance : null;
    const unitId = oracle.unitId || oracle.function || oracle.functionName || oracle.symbol || null;
    const input = actual?.input ?? actual?.inputs ?? actual?.arguments ?? oracle.input ?? oracle.inputs ?? oracle.arguments ?? null;
    const expected = {};
    if ("expectedReturn" in oracle) expected.return = oracle.expectedReturn;
    if ("expectedOutputs" in oracle) expected.outputs = oracle.expectedOutputs;
    if ("expectedState" in oracle) expected.state = oracle.expectedState;
    const expectedValues = Object.keys(expected).length > 0 ? expected : (oracle.expected ?? null);
    const actualValues = actual ? {
      return: actual.actualReturn ?? actual.returnValue ?? actual.return ?? null,
      outputs: actual.actualOutputs ?? actual.outputs ?? null,
      state: actual.actualState ?? actual.state ?? null
    } : null;
    const checks = [];
    if (!actual) {
      return { oracleId: oracle.oracleId, testcaseId: oracle.testcaseId || null, unitId, input, expected: expectedValues, actual: null, status: "missing_actual", checks };
    }
    if ("expectedReturn" in oracle) checks.push({ field: "return", passed: valuesEqual(oracle.expectedReturn, actual.actualReturn ?? actual.returnValue, tolerance), expected: oracle.expectedReturn, actual: actual.actualReturn ?? actual.returnValue });
    if ("expectedOutputs" in oracle) checks.push({ field: "outputs", passed: valuesEqual(oracle.expectedOutputs, actual.actualOutputs ?? actual.outputs, tolerance), expected: oracle.expectedOutputs, actual: actual.actualOutputs ?? actual.outputs });
    if ("expectedState" in oracle) checks.push({ field: "state", passed: valuesEqual(oracle.expectedState, actual.actualState ?? actual.state, tolerance), expected: oracle.expectedState, actual: actual.actualState ?? actual.state });
    return {
      oracleId: oracle.oracleId,
      testcaseId: oracle.testcaseId || null,
      unitId,
      input,
      expected: expectedValues,
      actual: actualValues,
      status: checks.every((item) => item.passed) ? "passed" : "mismatch",
      checks
    };
  });
  const summary = {
    total: results.length,
    passed: results.filter((item) => item.status === "passed").length,
    mismatch: results.filter((item) => item.status === "mismatch").length,
    missingActual: results.filter((item) => item.status === "missing_actual").length
  };
  const report = {
    schemaVersion: "unitverify.expected-comparison.v1",
    status: summary.mismatch === 0 && summary.missingActual === 0 ? "passed" : "expected_mismatch",
    summary,
    results
  };
  report.tokenUsage = buildPluginTokenUsage({
    inputPayloads: [
      { name: "oracleArtifact", value: oracleArtifact, surface: "unit-design" },
      { name: "actualArtifact", value: actualArtifact, surface: "test-result" }
    ],
    outputPayloads: [
      { name: "expectedComparisonReport", value: reportWithoutTokenUsage(report), surface: "report" }
    ]
  });
  const outFile = path.resolve(projectRoot, args.outFile || path.join(".perfectone", "unit-design", "expected-comparison.json"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
  return { ...report, outFile };
}

async function buildTraceabilityReportTool(args) {
  const { projectRoot, artifacts } = await loadArtifacts(args);
  const validations = artifacts.map((entry) => validateUnitDesignArtifact(entry.artifact));
  const traceArtifacts = artifacts.filter((entry) => entry.artifact?.schemaVersion === "unitverify.traceability.v1");
  const links = traceArtifacts.flatMap((entry) => entry.artifact.links || []);
  const htmlRows = links
    .map((link) => `<tr><td>${htmlEscape(link.requirementId || "")}</td><td>${htmlEscape((link.designIds || []).join(", "))}</td><td>${htmlEscape((link.testcaseIds || []).join(", "))}</td><td>${htmlEscape((link.assertionIds || []).join(", "))}</td><td>${htmlEscape((link.oracleIds || []).join(", "))}</td><td>${htmlEscape(JSON.stringify(link.coverage || {}))}</td><td>${htmlEscape(JSON.stringify(link.result || {}))}</td></tr>`)
    .join("\n");
  const outFile = path.resolve(projectRoot, args.outFile || path.join(".perfectone", "unit-design", "traceability.html"));
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, `<!doctype html>
<html><head><meta charset="utf-8"><title>Unit Verify Traceability</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;margin:32px;color:#111827}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d1d5db;padding:8px;text-align:left;vertical-align:top}th{background:#eef2ff}</style></head>
<body><h1>Unit Verify Traceability</h1><p>Links: ${htmlEscape(links.length)}</p>
<table><thead><tr><th>Requirement</th><th>Design</th><th>Testcases</th><th>Assertions</th><th>Oracles</th><th>Coverage</th><th>Result</th></tr></thead><tbody>${htmlRows}</tbody></table>
</body></html>
`, "utf8");
  return { status: validations.every((item) => item.valid) ? "passed" : "review_needed", outFile, links: links.length, validations };
}

function artifactPathsFromUnitDesignRefs(refs) {
  if (!refs || typeof refs !== "object") return [];
  const paths = [];
  for (const key of ["specAnalysis", "testDesign", "assertions", "oracles", "traceability", "review"]) {
    if (typeof refs[key] === "string") pushUnique(paths, refs[key]);
  }
  for (const item of refs.paths || []) {
    if (typeof item === "string") pushUnique(paths, item);
  }
  return paths;
}

async function validateUnitDesignRefs(projectRoot, refs) {
  const artifactPaths = artifactPathsFromUnitDesignRefs(refs);
  if (artifactPaths.length === 0) return { artifactPaths, validations: [] };
  try {
    const loaded = await loadArtifacts({ projectRoot, artifactPaths });
    return {
      artifactPaths,
      validations: loaded.artifacts.map((entry) => ({
        path: entry.path,
        ...validateUnitDesignArtifact(entry.artifact)
      }))
    };
  } catch (error) {
    return {
      artifactPaths,
      validations: [],
      error: String(error)
    };
  }
}

function normalizeSourceLanguage(language, sourceFile = "") {
  const value = String(language || "").toLowerCase();
  if (value) {
    if (value === "csharp" || value === "cs") return "csharp";
    if (value === "typescript" || value === "ts") return "ts";
    if (value === "javascript" || value === "js") return "js";
    if (value === "cpp" || value === "c++") return "cpp";
    return value;
  }
  const lower = String(sourceFile || "").toLowerCase();
  if (lower.endsWith(".c")) return "c";
  if (/\.(cc|cpp|cxx|hpp|hh|hxx)$/.test(lower)) return "cpp";
  if (/\.(ts|tsx)$/.test(lower)) return "ts";
  if (/\.(js|jsx)$/.test(lower)) return "js";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".rb")) return "ruby";
  return "unknown";
}

function stripInlineComment(line, language) {
  if (language === "python" || language === "ruby") return String(line || "").replace(/#.*$/, "");
  return String(line || "").replace(/\/\/.*$/, "");
}

function splitTopLevelComma(text) {
  const values = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (const char of String(text || "")) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if ("(<[{".includes(char)) depth += 1;
    if (")>]}".includes(char) && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function parseSourceParameter(raw, language) {
  const text = String(raw || "").trim();
  if (!text || text === "void") return null;
  if (language === "rust") {
    if (text === "self" || text === "&self" || text === "&mut self") {
      return { name: "self", type: text, role: text.includes("mut") ? "state" : "input", raw: text };
    }
    const match = text.match(/^([^:]+):\s*(.+)$/);
    if (match) {
      const name = match[1].trim().replace(/^mut\s+/, "");
      const type = match[2].trim();
      return { name, type, role: type.includes("&mut") ? "output_or_state" : "input", raw: text };
    }
    return { name: text, type: "unknown", role: "input", raw: text };
  }
  if (["js", "ts", "python", "ruby"].includes(language)) {
    const withoutDefault = text.split("=")[0].trim();
    const parts = withoutDefault.split(":");
    const name = parts[0].trim().replace(/^[.*\s]+/, "").replace(/[?]$/, "") || text;
    const type = parts.slice(1).join(":").trim() || "unknown";
    return { name, type, role: "input", raw: text };
  }
  const cleaned = text.replace(/\b(register|const|volatile|restrict|final)\b/g, " ").replace(/\s+/g, " ").trim();
  const nameMatch = cleaned.match(/([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?$/);
  const name = nameMatch ? nameMatch[1] : cleaned;
  const type = nameMatch ? cleaned.slice(0, nameMatch.index).trim() || "unknown" : "unknown";
  const pointerLike = /[*&]|\[[^\]]*\]/.test(cleaned);
  const constLike = /\bconst\b/.test(text);
  return { name, type, role: pointerLike && !constLike ? "output_or_state" : "input", raw: text };
}

function parseSourceParameters(paramText, language) {
  return splitTopLevelComma(paramText)
    .map((item) => parseSourceParameter(item, language))
    .filter(Boolean);
}

function matchSourceSignature(window, language) {
  const keywords = new Set(["if", "for", "while", "switch", "catch", "return", "sizeof", "do", "else"]);
  const compact = stripInlineComment(window, language).replace(/\s+/g, " ").trim();
  if (!compact || compact.startsWith("#")) return null;
  let match = null;
  if (language === "rust") {
    match = compact.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]+>)?\s*\(([^)]*)\)\s*(?:->\s*([^{}]+?))?\s*\{/);
    if (match) return { symbol: match[1], params: match[2], returnType: (match[3] || "()").trim(), kind: "function" };
  }
  if (language === "go") {
    match = compact.match(/^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*([^{}]*)\{/);
    if (match) return { symbol: match[1], params: match[2], returnType: (match[3] || "").trim() || "void", kind: "function" };
  }
  if (["js", "ts"].includes(language)) {
    match = compact.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{}]+?))?\s*\{/);
    if (match) return { symbol: match[1], params: match[2], returnType: (match[3] || "unknown").trim(), kind: "function" };
    match = compact.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*([^=]+?))?\s*=>\s*\{/);
    if (match) return { symbol: match[1], params: match[2], returnType: (match[3] || "unknown").trim(), kind: "function" };
    match = compact.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*([^{}]+?))?\s*\{/);
    if (match && !keywords.has(match[1])) return { symbol: match[1], params: match[2], returnType: (match[3] || "unknown").trim(), kind: "method" };
  }
  if (language === "python") {
    match = compact.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/);
    if (match) return { symbol: match[1], params: match[2], returnType: (match[3] || "unknown").trim(), kind: "function" };
  }
  if (language === "ruby") {
    match = compact.match(/^def\s+([A-Za-z_]\w*[!?=]?)\s*(?:\(([^)]*)\)|([^#]*))/);
    if (match) return { symbol: match[1], params: match[2] || match[3] || "", returnType: "unknown", kind: "function" };
  }
  match = compact.match(/^(?:template\s*<[^{}]+>\s*)?(?:(?:public|private|protected|static|inline|extern|constexpr|virtual|friend|const|volatile|signed|unsigned|long|short|struct|enum|class|typename|auto|void|bool|char|int|float|double|size_t|uint\d+_t|int\d+_t|[A-Za-z_][\w:<>~*&,\[\]]*)\s+)+([A-Za-z_~]\w*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:->\s*([^{}]+?))?\s*\{/);
  if (match && !keywords.has(match[1])) {
    const prefix = compact.slice(0, compact.indexOf(match[1])).trim();
    const returnType = (match[3] || prefix.replace(/\s+$/, "") || "unknown").trim();
    return { symbol: match[1], params: match[2], returnType, kind: language === "cpp" || language === "java" || language === "csharp" ? "method_or_function" : "function" };
  }
  return null;
}

function findBraceBlockEnd(lines, startLine) {
  let depth = 0;
  let started = false;
  for (let lineIndex = startLine; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth <= 0) return lineIndex;
      }
    }
  }
  return lines.length - 1;
}

function findIndentedBlockEnd(lines, startLine) {
  const startIndent = (lines[startLine].match(/^\s*/) || [""])[0].length;
  for (let lineIndex = startLine + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    const indent = (line.match(/^\s*/) || [""])[0].length;
    if (indent <= startIndent && /^(?:async\s+)?def\s+|^class\s+/.test(line.trim())) return lineIndex - 1;
  }
  return lines.length - 1;
}

function sourceRef(relativeFile, line) {
  return `${relativeFile}:${line}`;
}

function astLocationLine(node) {
  return node?.loc?.line || node?.range?.begin?.line || node?.range?.end?.line || null;
}

function astLocationFile(node) {
  return node?.loc?.file || node?.range?.begin?.file || node?.range?.end?.file || "";
}

function astNodeInSourceFile(node, sourcePath) {
  const file = astLocationFile(node);
  if (!file) return true;
  const normalizedNode = path.resolve(file).toLowerCase();
  const normalizedSource = path.resolve(sourcePath).toLowerCase();
  return normalizedNode === normalizedSource || normalizedNode.endsWith(path.basename(normalizedSource));
}

function astSourceSnippet(node, lines, fallbackLine = null) {
  const begin = node?.range?.begin || {};
  const end = node?.range?.end || {};
  const startLine = begin.line || fallbackLine;
  const endLine = end.line || startLine;
  if (!startLine || startLine < 1 || startLine > lines.length) return "";
  if (endLine === startLine) {
    const line = lines[startLine - 1] || "";
    const startCol = Math.max((begin.col || 1) - 1, 0);
    const endCol = Math.max((end.col || line.length + 1) - 1, startCol);
    return line.slice(startCol, endCol || undefined).trim();
  }
  return lines.slice(startLine - 1, Math.min(endLine, lines.length)).join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function astHasKind(node, kind) {
  if (!node || typeof node !== "object") return false;
  if (node.kind === kind) return true;
  return (node.inner || []).some((child) => astHasKind(child, kind));
}

function walkAst(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const child of node.inner || []) walkAst(child, visitor);
}

function directAstChildren(node, kind) {
  return (node?.inner || []).filter((child) => child.kind === kind);
}

function parseReturnTypeFromQualType(qualType) {
  const text = String(qualType || "").trim();
  const index = text.indexOf("(");
  if (index > 0) return text.slice(0, index).trim();
  return text || "unknown";
}

function clangToolForLanguage(language) {
  if (language === "cpp") return resolveTool("clang++") || resolveTool("clang");
  if (language === "c") return resolveTool("clang");
  return null;
}

function runClangAstDump({ sourcePath, language, compileArgs = [], timeoutMs = 60000 }) {
  const clang = clangToolForLanguage(language);
  if (!clang) {
    return { ok: false, reason: "clang_not_found", diagnostics: [{ severity: "warning", code: "clang_not_found", message: "Clang was not found on PATH or known LLVM locations.", source: "mcp" }] };
  }
  const langArgs = language === "cpp" ? ["-x", "c++"] : ["-x", "c"];
  const defaultStd = language === "cpp" ? ["-std=c++17"] : ["-std=gnu11"];
  const args = [...langArgs, ...defaultStd, ...compileArgs, "-Xclang", "-ast-dump=json", "-fsyntax-only", sourcePath];
  const result = spawnSync(clang, args, {
    cwd: path.dirname(sourcePath),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true
  });
  if (result.status !== 0 || !result.stdout) {
    return {
      ok: false,
      command: [clang, ...args].join(" "),
      exitCode: result.status,
      stderr: truncate(result.stderr || result.stdout || "", 4000),
      diagnostics: [{
        severity: "warning",
        code: "clang_ast_dump_failed",
        message: `Clang AST dump failed for ${sourcePath}. Falling back to lightweight extraction.`,
        source: "mcp"
      }]
    };
  }
  try {
    return {
      ok: true,
      command: [clang, ...args].join(" "),
      ast: JSON.parse(result.stdout),
      diagnostics: result.stderr ? [{ severity: "info", code: "clang_ast_stderr", message: truncate(result.stderr, 2000), source: "clang" }] : []
    };
  } catch (error) {
    return {
      ok: false,
      command: [clang, ...args].join(" "),
      stderr: truncate(result.stderr || "", 4000),
      diagnostics: [{ severity: "warning", code: "clang_ast_json_parse_failed", message: String(error), source: "mcp" }]
    };
  }
}

function extractClangAstUnits({ sourcePath, relativeFile, text, language, symbols, compileArgs = [] }) {
  const astDump = runClangAstDump({ sourcePath, language, compileArgs });
  const diagnostics = [...(astDump.diagnostics || [])];
  if (!astDump.ok) return { units: [], diagnostics, backend: "clang-ast-json", used: false };
  const lines = String(text || "").split(/\r?\n/);
  const symbolSet = new Set((symbols || []).filter(Boolean));
  const units = [];
  const functionKinds = new Set(["FunctionDecl", "CXXMethodDecl", "CXXConstructorDecl", "CXXDestructorDecl"]);
  const branchKinds = new Set(["IfStmt", "SwitchStmt", "WhileStmt", "DoStmt", "ForStmt", "CXXForRangeStmt", "CaseStmt", "DefaultStmt"]);
  walkAst(astDump.ast, (node) => {
    if (!functionKinds.has(node.kind)) return;
    if (!node.name || !astNodeInSourceFile(node, sourcePath)) return;
    if (symbolSet.size > 0 && !symbolSet.has(node.name)) return;
    if (!astHasKind(node, "CompoundStmt")) return;
    const lineStart = astLocationLine(node) || 1;
    const lineEnd = node?.range?.end?.line || lineStart;
    const unitId = `${slug(path.basename(relativeFile, path.extname(relativeFile)))}.${slug(node.name)}`;
    if (units.some((item) => item.unitId === unitId)) return;
    const parameters = directAstChildren(node, "ParmVarDecl").map((param) => ({
      name: param.name || "param",
      type: param.type?.qualType || "unknown",
      role: /[*&]|\bptr\b/i.test(param.type?.qualType || "") ? "output_or_state" : "input",
      raw: `${param.type?.qualType || "unknown"} ${param.name || ""}`.trim()
    }));
    const branches = [];
    const returns = [];
    walkAst(node, (child) => {
      if (child === node) return;
      const childLine = astLocationLine(child);
      if (!childLine || childLine < lineStart || childLine > lineEnd) return;
      if (branchKinds.has(child.kind) && astNodeInSourceFile(child, sourcePath)) {
        const snippet = astSourceSnippet(child, lines, childLine) || child.kind;
        branches.push({
          branchId: `${unitId}-br-${branches.length + 1}`,
          unitId,
          symbol: node.name,
          kind: child.kind.replace(/Stmt$/, "").toLowerCase(),
          expression: snippet,
          sourceRef: sourceRef(relativeFile, childLine),
          evidence: `Clang AST ${child.kind} at ${sourceRef(relativeFile, childLine)}: ${snippet}`,
          reviewStatus: "needs_review",
          origin: "clang-ast-json"
        });
      }
      if (child.kind === "ReturnStmt" && astNodeInSourceFile(child, sourcePath)) {
        const snippet = astSourceSnippet(child, lines, childLine).replace(/^return\s*/, "").replace(/;$/, "").trim();
        returns.push({
          returnId: `${unitId}-ret-${returns.length + 1}`,
          unitId,
          expression: snippet,
          sourceRef: sourceRef(relativeFile, childLine),
          evidence: `Clang AST ReturnStmt at ${sourceRef(relativeFile, childLine)}: ${snippet}`,
          origin: "clang-ast-json"
        });
      }
    });
    const bodyLines = lines.slice(lineStart - 1, lineEnd);
    const stateCandidates = extractStateCandidatesFromBody({ unitId, symbol: node.name, lineStart }, bodyLines, relativeFile, language)
      .map((item) => ({ ...item, origin: "source-text-with-clang-range" }));
    units.push({
      unitId,
      language,
      file: sourcePath,
      relativeFile,
      symbol: node.name,
      kind: node.kind,
      signature: astSourceSnippet(node, lines, lineStart).replace(/\s*\{.*$/, "").trim() || `${parseReturnTypeFromQualType(node.type?.qualType)} ${node.name}(...)`,
      returnType: parseReturnTypeFromQualType(node.type?.qualType),
      parameters,
      lineStart,
      lineEnd,
      sourceRef: sourceRef(relativeFile, lineStart),
      evidence: `Clang AST ${node.kind} at ${sourceRef(relativeFile, lineStart)}: ${node.name} ${node.type?.qualType || ""}`.trim(),
      branches,
      returns,
      stateCandidates,
      extractionBackend: "clang-ast-json",
      clangCommand: astDump.command
    });
  });
  return { units, diagnostics, backend: "clang-ast-json", used: units.length > 0, command: astDump.command };
}

function classifyComparisonValue(raw) {
  const value = String(raw || "").trim();
  if (/^(NULL|null|nullptr|None|nil)$/.test(value)) return { kind: "null", value };
  if (/^(true|false|TRUE|FALSE)$/.test(value)) return { kind: "boolean", value };
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return { kind: "number", value: Number(value) };
  if (/^['"].*['"]$/.test(value)) return { kind: "literal", value };
  return { kind: "symbol", value };
}

function extractConditionsFromBody(unit, bodyLines, relativeFile, language) {
  const branches = [];
  const addBranch = (kind, expression, lineNumber) => {
    const expr = String(expression || "").trim();
    if (!expr) return;
    branches.push({
      branchId: `${unit.unitId}-br-${branches.length + 1}`,
      unitId: unit.unitId,
      symbol: unit.symbol,
      kind,
      expression: expr,
      sourceRef: sourceRef(relativeFile, lineNumber),
      evidence: `${kind} condition at ${sourceRef(relativeFile, lineNumber)}: ${expr}`,
      reviewStatus: "needs_review"
    });
  };
  for (let offset = 0; offset < bodyLines.length; offset += 1) {
    const lineNumber = unit.lineStart + offset;
    const line = stripInlineComment(bodyLines[offset], language);
    for (const match of line.matchAll(/\b(if|while|switch)\s*\(([^;{}]+)\)/g)) addBranch(match[1], match[2], lineNumber);
    for (const match of line.matchAll(/\bfor\s*\(([^;{}]+)\)/g)) addBranch("for", match[1], lineNumber);
    for (const match of line.matchAll(/\bcase\s+([^:]+)\s*:/g)) addBranch("case", match[1], lineNumber);
    if (language === "rust") {
      for (const match of line.matchAll(/\bmatch\s+([^{]+)\s*\{/g)) addBranch("match", match[1], lineNumber);
      for (const match of line.matchAll(/^\s*([^=|{}][^=]*?)\s*=>/g)) addBranch("match_arm", match[1], lineNumber);
    }
    if (language === "python") {
      for (const match of line.matchAll(/\b(if|elif|while)\s+([^:]+)\s*:/g)) addBranch(match[1], match[2], lineNumber);
    }
    if (language === "ruby") {
      for (const match of line.matchAll(/\b(if|elsif|unless|while)\s+(.+)$/g)) addBranch(match[1], match[2], lineNumber);
    }
  }
  return branches;
}

function extractReturnsFromBody(unit, bodyLines, relativeFile, language) {
  const returns = [];
  for (let offset = 0; offset < bodyLines.length; offset += 1) {
    const lineNumber = unit.lineStart + offset;
    const line = stripInlineComment(bodyLines[offset], language);
    const patterns = language === "python" || language === "ruby"
      ? [/\breturn\s+(.+)$/g]
      : [/\breturn\s+([^;]+)\s*;/g, /\bthrow\s+([^;]+)\s*;/g];
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        returns.push({
          returnId: `${unit.unitId}-ret-${returns.length + 1}`,
          unitId: unit.unitId,
          expression: match[1].trim(),
          sourceRef: sourceRef(relativeFile, lineNumber),
          evidence: `Return or error path at ${sourceRef(relativeFile, lineNumber)}: ${match[1].trim()}`
        });
      }
    }
  }
  return returns;
}

function extractStateCandidatesFromBody(unit, bodyLines, relativeFile, language) {
  const candidates = [];
  for (let offset = 0; offset < bodyLines.length; offset += 1) {
    const lineNumber = unit.lineStart + offset;
    const line = stripInlineComment(bodyLines[offset], language);
    for (const match of line.matchAll(/([A-Za-z_]\w*(?:->|\.|::)[A-Za-z_]\w*|this\.[A-Za-z_]\w*|self\.[A-Za-z_]\w*)\s*([+\-*/%]?=)\s*([^;]+)/g)) {
      candidates.push({
        stateId: `${unit.unitId}-state-${candidates.length + 1}`,
        unitId: unit.unitId,
        target: match[1],
        operator: match[2],
        value: match[3].trim(),
        sourceRef: sourceRef(relativeFile, lineNumber),
        evidence: `State-like assignment at ${sourceRef(relativeFile, lineNumber)}: ${match[0].trim()}`,
        reviewStatus: "needs_review"
      });
    }
  }
  return candidates;
}

function deriveBoundaryAndEquivalence(unit, branches) {
  const boundaryValues = [];
  const equivalencePartitions = [];
  const seenBoundary = new Set();
  const seenPartition = new Set();
  for (const branch of branches) {
    for (const match of String(branch.expression || "").matchAll(/([A-Za-z_][\w.\->\[\]]*)\s*(==|!=|<=|>=|<|>)\s*([A-Za-z_][\w.]*|-?\d+(?:\.\d+)?|NULL|null|nullptr|None|nil|true|false|TRUE|FALSE|'[^']*'|"[^"]*")/g)) {
      const left = match[1];
      const operator = match[2];
      const right = classifyComparisonValue(match[3]);
      if (right.kind === "number" && ["<", "<=", ">", ">="].includes(operator)) {
        const key = `${unit.unitId}:${left}:${operator}:${right.value}:${branch.sourceRef}`;
        if (!seenBoundary.has(key)) {
          seenBoundary.add(key);
          boundaryValues.push({
            boundaryId: `${unit.unitId}-bnd-${boundaryValues.length + 1}`,
            unitId: unit.unitId,
            variable: left,
            operator,
            value: right.value,
            candidates: [right.value - 1, right.value, right.value + 1],
            sourceRef: branch.sourceRef,
            evidence: branch.evidence,
            reviewStatus: "inferred",
            confidence: 0.55
          });
        }
        if (!seenPartition.has(key)) {
          seenPartition.add(key);
          equivalencePartitions.push({
            partitionId: `${unit.unitId}-eq-${equivalencePartitions.length + 1}`,
            unitId: unit.unitId,
            variable: left,
            operator,
            representative: right.value,
            classes: [`${left} ${operator} ${right.value}`, `${left} not(${operator}) ${right.value}`],
            sourceRef: branch.sourceRef,
            evidence: branch.evidence,
            reviewStatus: "inferred",
            confidence: 0.55
          });
        }
      }
      if (["==", "!="].includes(operator) || right.kind === "null" || right.kind === "boolean" || right.kind === "literal" || right.kind === "symbol") {
        const key = `${unit.unitId}:${left}:${operator}:${right.value}:${branch.sourceRef}`;
        if (!seenPartition.has(key)) {
          seenPartition.add(key);
          equivalencePartitions.push({
            partitionId: `${unit.unitId}-eq-${equivalencePartitions.length + 1}`,
            unitId: unit.unitId,
            variable: left,
            operator,
            representative: right.value,
            classes: [`${left} ${operator} ${right.value}`, `${left} not(${operator}) ${right.value}`],
            sourceRef: branch.sourceRef,
            evidence: branch.evidence,
            reviewStatus: "inferred",
            confidence: 0.55
          });
        }
      }
    }
  }
  for (const param of unit.parameters || []) {
    const name = param.name || "param";
    const typeText = `${param.type || ""} ${param.raw || ""}`;
    const hasBoundary = () => [...seenBoundary].some((key) => key.includes(`${unit.unitId}:${name}:`));
    const hasPartition = () => [...seenPartition].some((key) => key.includes(`${unit.unitId}:${name}:`));
    const addBoundary = ({ operator, value, candidates, evidence, confidence = 0.3 }) => {
      const key = `${unit.unitId}:${name}:type-derived:0:${unit.sourceRef}`;
      if (hasBoundary()) return;
      seenBoundary.add(key);
      boundaryValues.push({
        boundaryId: `${unit.unitId}-bnd-${boundaryValues.length + 1}`,
        unitId: unit.unitId,
        variable: name,
        operator,
        value,
        candidates,
        sourceRef: unit.sourceRef,
        evidence,
        reviewStatus: "inferred",
        confidence
      });
    };
    const addPartition = ({ operator, representative, classes, evidence, confidence = 0.3 }) => {
      const key = `${unit.unitId}:${name}:type-derived:classes:${unit.sourceRef}`;
      if (hasPartition()) return;
      seenPartition.add(key);
      equivalencePartitions.push({
        partitionId: `${unit.unitId}-eq-${equivalencePartitions.length + 1}`,
        unitId: unit.unitId,
        variable: name,
        operator,
        representative,
        classes,
        sourceRef: unit.sourceRef,
        evidence,
        reviewStatus: "inferred",
        confidence
      });
    };
    if (/\b(bool|boolean|_Bool)\b/i.test(typeText)) {
      addBoundary({
        operator: "boolean-domain",
        value: false,
        candidates: [false, true],
        evidence: `Type-derived boolean boundary/domain candidates for ${name} in ${unit.symbol}.`
      });
      addPartition({
        operator: "boolean-domain",
        representative: false,
        classes: [`${name} == false`, `${name} == true`],
        evidence: `Type-derived boolean equivalence classes for ${name} in ${unit.symbol}.`
      });
    } else if (typeText.includes("*") || /\bptr\b/i.test(typeText)) {
      addBoundary({
        operator: "pointer-domain",
        value: null,
        candidates: [null, "valid_non_null"],
        evidence: `Type-derived pointer boundary candidates for ${name} in ${unit.symbol}.`
      });
      addPartition({
        operator: "pointer-domain",
        representative: null,
        classes: [`${name} is null`, `${name} is valid non-null`, `${name} is invalid/dangling`],
        evidence: `Type-derived pointer equivalence classes for ${name} in ${unit.symbol}.`
      });
    } else if (/\b(string|str|char\s*\*|wchar_t\s*\*)\b/i.test(typeText)) {
      addBoundary({
        operator: "sequence-length-domain",
        value: 0,
        candidates: ["empty", "single", "many", "max_length_or_limit"],
        evidence: `Type-derived string/sequence boundary candidates for ${name} in ${unit.symbol}.`
      });
      addPartition({
        operator: "sequence-length-domain",
        representative: "empty",
        classes: [`${name} empty`, `${name} length 1`, `${name} nominal length`, `${name} over max or invalid format`],
        evidence: `Type-derived string/sequence equivalence classes for ${name} in ${unit.symbol}.`
      });
    } else if (/\b(char|short|int|long|float|double|size_t|ssize_t|uint\d*_t|int\d*_t|number)\b/i.test(typeText)) {
      addBoundary({
        operator: "type-derived",
        value: 0,
        candidates: [-1, 0, 1],
        evidence: `Type-derived numeric boundary candidates for ${name} in ${unit.symbol}.`
      });
      addPartition({
        operator: "type-derived",
        representative: 0,
        classes: [`${name} < 0`, `${name} == 0`, `${name} > 0`],
        evidence: `Type-derived numeric equivalence classes for ${name} in ${unit.symbol}.`
      });
    } else {
      addPartition({
        operator: "type-derived-review",
        representative: "valid_nominal",
        classes: [`${name} valid nominal`, `${name} invalid or unsupported`],
        evidence: `Fallback equivalence classes for ${name} in ${unit.symbol}; concrete values require review.`,
        confidence: 0.2
      });
    }
  }
  return { boundaryValues, equivalencePartitions };
}

function deriveUndefinedBehaviorRisks(unit) {
  const risks = [];
  const addRisk = (riskType, sourceRefValue, evidence, expectedRisk) => {
    const key = `${unit.unitId}:${riskType}:${sourceRefValue}:${evidence}`;
    if (risks.some((item) => item.key === key)) return;
    risks.push({
      key,
      ubCaseId: `${unit.unitId}-ub-${risks.length + 1}`,
      unitId: unit.unitId,
      symbol: unit.symbol,
      riskType,
      expectedRisk,
      sourceRef: sourceRefValue || unit.sourceRef,
      evidence,
      reviewStatus: "needs_review",
      confidence: 0.35,
      executionPolicy: "generate_and_execute_only_if_source_review_confirms_plausible_risk"
    });
  };
  for (const param of unit.parameters || []) {
    const raw = `${param.raw || ""} ${param.type || ""}`;
    if (raw.includes("*")) {
      addRisk("null_or_invalid_pointer", unit.sourceRef, `Pointer-like parameter '${param.name || param.raw || "unknown"}' in ${unit.symbol} may need null/invalid pointer corner-case review.`, "segfault_or_memory_error");
    }
    if (/\[[^\]]*\]/.test(raw)) {
      addRisk("array_bounds", unit.sourceRef, `Array-like parameter '${param.name || param.raw || "unknown"}' in ${unit.symbol} may need bounds corner-case review.`, "memory_error_or_undefined_behavior_suspected");
    }
  }
  for (const branch of unit.branches || []) {
    const expr = String(branch.expression || "");
    if (expr.includes("->")) addRisk("null_pointer_dereference", branch.sourceRef, `Pointer dereference-like condition '${expr}' needs null/invalid pointer review.`, "segfault_or_memory_error");
    if (/\[[^\]]+\]/.test(expr)) addRisk("array_bounds", branch.sourceRef, `Indexed condition '${expr}' needs out-of-bounds review.`, "memory_error_or_undefined_behavior_suspected");
    if (/(\/|%)\s*[A-Za-z_]\w*/.test(expr)) addRisk("divide_by_zero", branch.sourceRef, `Division or modulo expression '${expr}' needs zero-divisor review.`, "runtime_failure_or_undefined_behavior_suspected");
  }
  for (const item of [...(unit.returns || []), ...(unit.stateCandidates || [])]) {
    const expr = String(item.expression || item.value || "");
    if (/(\/|%)\s*[A-Za-z_]\w*/.test(expr)) addRisk("divide_by_zero", item.sourceRef, `Expression '${expr}' may divide or modulo by a variable.`, "runtime_failure_or_undefined_behavior_suspected");
    if (/\[[^\]]+\]/.test(expr)) addRisk("array_bounds", item.sourceRef, `Expression '${expr}' contains indexed access.`, "memory_error_or_undefined_behavior_suspected");
    if (/[A-Za-z_]\w*\s*([+*]|-\s*[A-Za-z_])/.test(expr) && /\b(int|long|short|signed)\b/i.test(String(unit.returnType || ""))) {
      addRisk("signed_overflow", item.sourceRef, `Signed integer expression '${expr}' may need overflow boundary review.`, "overflow_risk_or_undefined_behavior_suspected");
    }
  }
  return risks.map(({ key: _key, ...item }) => item);
}

function deriveAbnormalBehaviorRisks(unit) {
  const risks = [];
  const addRisk = (riskType, sourceRefValue, evidence, expectedRisk) => {
    const key = `${unit.unitId}:${riskType}:${sourceRefValue}:${evidence}`;
    if (risks.some((item) => item.key === key)) return;
    risks.push({
      key,
      abCaseId: `${unit.unitId}-ab-${risks.length + 1}`,
      unitId: unit.unitId,
      symbol: unit.symbol,
      riskType,
      expectedRisk,
      sourceRef: sourceRefValue || unit.sourceRef,
      evidence,
      reviewStatus: "needs_review",
      confidence: 0.3,
      executionPolicy: "generate_and_execute_only_if_source_or_spec_review_confirms_plausible_abnormal_behavior"
    });
  };
  for (const branch of unit.branches || []) {
    const expr = String(branch.expression || "");
    if (/\b(error|fail|invalid|timeout|unsupported|overflow|underflow|exception|abort)\b/i.test(expr)) {
      addRisk("error_or_invalid_path", branch.sourceRef, `Guard condition '${expr}' appears to select an abnormal or error path.`, "error_return_exception_or_invalid_state");
    }
    if (/\b(state|mode|status)\b/i.test(expr) && /(!=|==|<|>|<=|>=)/.test(expr)) {
      addRisk("invalid_state_or_mode", branch.sourceRef, `State/mode guard '${expr}' may need abnormal invalid-state review.`, "invalid_state_or_mode_behavior");
    }
  }
  for (const item of unit.returns || []) {
    const expr = String(item.expression || "");
    if (/^-\d+$/.test(expr.trim()) || /\b(error|fail|invalid|null|none|nil|throw|exception)\b/i.test(expr)) {
      addRisk("error_return_or_exception", item.sourceRef, `Return or error expression '${expr}' appears to represent abnormal behavior.`, "error_return_exception_or_missing_actual");
    }
  }
  return risks.map(({ key: _key, ...item }) => item);
}

function buildTestTechniqueSummary({ hasStateCandidates, hasUndefinedBehaviorRisks, hasAbnormalBehaviorRisks }) {
  return [
    {
      technique: "coverage_growth",
      source: "code",
      required: "always",
      status: "generated",
      applicationReason: "Source-only verification must add coverage-growth testcases after the baseline coverage result."
    },
    {
      technique: "boundary_value",
      source: "code_or_spec",
      required: "always",
      status: "generated",
      applicationReason: "Boundary-value testcases are required for code-only and specification-driven verification."
    },
    {
      technique: "equivalence_partition",
      source: "code_or_spec",
      required: "always",
      status: "generated",
      applicationReason: "Equivalence-partition testcases are required for code-only and specification-driven verification."
    },
    {
      technique: "undefined_behavior_corner",
      source: "code_review",
      required: "conditional",
      status: hasUndefinedBehaviorRisks ? "needs_review_generated" : "not_applicable",
      applicationReason: hasUndefinedBehaviorRisks
        ? "Source review found plausible UB risk candidates."
        : "No obvious UB risk candidate was detected by lightweight source review."
    },
    {
      technique: "abnormal_behavior_corner",
      source: "code_or_spec_review",
      required: "conditional",
      status: hasAbnormalBehaviorRisks ? "needs_review_generated" : "not_applicable",
      applicationReason: hasAbnormalBehaviorRisks
        ? "Source or specification review found plausible abnormal behavior candidates."
        : "No obvious abnormal behavior candidate was detected by lightweight review."
    },
    {
      technique: "decision_table",
      source: "spec_or_source_branches",
      required: "when_specification_or_branches_exist",
      status: "generated",
      applicationReason: "Decision rows are derived from branch and guard conditions; specification-provided condition/action combinations remain authoritative when present."
    },
    {
      technique: "state_transition",
      source: "spec_or_state_candidates",
      required: "when_state_model_exists",
      status: hasStateCandidates ? "generated" : "not_applicable",
      applicationReason: hasStateCandidates
        ? "State-like assignments were detected and should be reviewed as transition candidates."
        : "No state-like assignment or explicit state model was detected."
    }
  ];
}

function literalReturnValue(expression) {
  const value = String(expression || "").trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (/^(true|false)$/.test(value)) return value === "true";
  if (/^(NULL|null|nullptr|None|nil)$/.test(value)) return null;
  if (/^['"].*['"]$/.test(value)) return value.slice(1, -1);
  if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return value;
  return undefined;
}

function externalAdapterTool(language) {
  if (language === "python") return resolveTool("python");
  if (language === "go") return resolveTool("go");
  if (language === "java") return resolveTool("javac");
  if (language === "ruby") return resolveTool("ruby");
  if (language === "js" || language === "ts") return resolveTool("node");
  return null;
}

function adapterScriptForLanguage(language) {
  if (language === "python") {
    return String.raw`
import ast, json, sys
path = sys.argv[1]
source = open(path, encoding="utf-8-sig").read()
tree = ast.parse(source, filename=path)
units = []
class Visitor(ast.NodeVisitor):
    def __init__(self):
        self.stack = []
    def visit_FunctionDef(self, node):
        self.handle(node, "FunctionDef")
    def visit_AsyncFunctionDef(self, node):
        self.handle(node, "AsyncFunctionDef")
    def handle(self, node, kind):
        params = []
        for arg in list(node.args.posonlyargs) + list(node.args.args) + list(node.args.kwonlyargs):
            params.append({"name": arg.arg, "type": ast.unparse(arg.annotation) if arg.annotation else "unknown", "role": "input", "raw": arg.arg})
        if node.args.vararg:
            params.append({"name": node.args.vararg.arg, "type": "varargs", "role": "input", "raw": "*" + node.args.vararg.arg})
        if node.args.kwarg:
            params.append({"name": node.args.kwarg.arg, "type": "kwargs", "role": "input", "raw": "**" + node.args.kwarg.arg})
        branches = []
        returns = []
        states = []
        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While)):
                branches.append({"kind": child.__class__.__name__, "expression": ast.unparse(child.test), "line": getattr(child, "lineno", node.lineno)})
            elif isinstance(child, ast.For):
                branches.append({"kind": "For", "expression": ast.unparse(child.target) + " in " + ast.unparse(child.iter), "line": getattr(child, "lineno", node.lineno)})
            elif isinstance(child, ast.Return):
                returns.append({"expression": ast.unparse(child.value) if child.value else "None", "line": getattr(child, "lineno", node.lineno)})
            elif isinstance(child, ast.Assign):
                for target in child.targets:
                    if isinstance(target, ast.Attribute):
                        states.append({"target": ast.unparse(target), "operator": "=", "value": ast.unparse(child.value), "line": getattr(child, "lineno", node.lineno)})
        units.append({"symbol": node.name, "kind": kind, "signature": ast.unparse(node).split("\\n")[0], "returnType": ast.unparse(node.returns) if node.returns else "unknown", "parameters": params, "lineStart": node.lineno, "lineEnd": getattr(node, "end_lineno", node.lineno), "branches": branches, "returns": returns, "stateCandidates": states})
Visitor().visit(tree)
print(json.dumps({"units": units}))
`;
  }
  if (language === "go") {
    return String.raw`
package main
import (
  "encoding/json"
  "fmt"
  "go/ast"
  "go/parser"
  "go/token"
  "os"
)
type Param map[string]any
type Branch map[string]any
type Ret map[string]any
type Unit map[string]any
func exprString(e ast.Expr) string { if e == nil { return "" }; return fmt.Sprintf("%#v", e) }
func fieldType(f *ast.Field) string { if f == nil || f.Type == nil { return "unknown" }; return fmt.Sprintf("%#v", f.Type) }
func main() {
  path := os.Args[len(os.Args)-1]
  fset := token.NewFileSet()
  file, err := parser.ParseFile(fset, path, nil, 0)
  if err != nil { fmt.Fprintln(os.Stderr, err); os.Exit(2) }
  units := []Unit{}
  for _, decl := range file.Decls {
    fn, ok := decl.(*ast.FuncDecl); if !ok || fn.Body == nil { continue }
    params := []Param{}
    if fn.Type.Params != nil {
      for _, p := range fn.Type.Params.List {
        typ := fieldType(p)
        if len(p.Names) == 0 { params = append(params, Param{"name":"param", "type":typ, "role":"input", "raw":typ}) }
        for _, n := range p.Names { params = append(params, Param{"name":n.Name, "type":typ, "role":"input", "raw":n.Name+" "+typ}) }
      }
    }
    ret := "void"; if fn.Type.Results != nil && len(fn.Type.Results.List) > 0 { ret = fieldType(fn.Type.Results.List[0]) }
    branches := []Branch{}; returns := []Ret{}
    ast.Inspect(fn.Body, func(n ast.Node) bool {
      switch x := n.(type) {
      case *ast.IfStmt: branches = append(branches, Branch{"kind":"IfStmt", "expression":exprString(x.Cond), "line":fset.Position(x.Pos()).Line})
      case *ast.ForStmt: branches = append(branches, Branch{"kind":"ForStmt", "expression":exprString(x.Cond), "line":fset.Position(x.Pos()).Line})
      case *ast.RangeStmt: branches = append(branches, Branch{"kind":"RangeStmt", "expression":exprString(x.X), "line":fset.Position(x.Pos()).Line})
      case *ast.SwitchStmt: branches = append(branches, Branch{"kind":"SwitchStmt", "expression":exprString(x.Tag), "line":fset.Position(x.Pos()).Line})
      case *ast.CaseClause: branches = append(branches, Branch{"kind":"CaseClause", "expression":fmt.Sprintf("%#v", x.List), "line":fset.Position(x.Pos()).Line})
      case *ast.ReturnStmt: returns = append(returns, Ret{"expression":fmt.Sprintf("%#v", x.Results), "line":fset.Position(x.Pos()).Line})
      }
      return true
    })
    units = append(units, Unit{"symbol":fn.Name.Name, "kind":"FuncDecl", "signature":fn.Name.Name, "returnType":ret, "parameters":params, "lineStart":fset.Position(fn.Pos()).Line, "lineEnd":fset.Position(fn.End()).Line, "branches":branches, "returns":returns, "stateCandidates":[]any{}})
  }
  json.NewEncoder(os.Stdout).Encode(map[string]any{"units": units})
}
`;
  }
  if (language === "ruby") {
    return String.raw`
require "json"
require "ripper"
path = ARGV[0]
src = File.read(path, encoding: "bom|utf-8")
sexp = Ripper.sexp(src)
units = []
lines = src.lines
lines.each_with_index do |line, idx|
  if line =~ /^\s*def\s+([A-Za-z_]\w*[!?=]?)\s*(?:\(([^)]*)\)|([^#]*))/
    name = $1
    params = (($2 || $3 || "").split(",").map(&:strip).reject(&:empty?).map { |p| {"name"=>p.split("=").first.strip, "type"=>"unknown", "role"=>"input", "raw"=>p} })
    end_line = idx + 1
    depth = 0
    lines[idx..].each_with_index do |l, off|
      depth += 1 if l =~ /^\s*(def|if|unless|case|while|until|for|begin)\b/
      if l =~ /^\s*end\b/
        depth -= 1
        if depth <= 0
          end_line = idx + off + 1
          break
        end
      end
    end
    body = lines[idx...end_line]
    branches = []
    returns = []
    body.each_with_index do |l, off|
      ln = idx + off + 1
      branches << {"kind"=>"if", "expression"=>$1.strip, "line"=>ln} if l =~ /\bif\s+(.+)$/
      branches << {"kind"=>"elsif", "expression"=>$1.strip, "line"=>ln} if l =~ /\belsif\s+(.+)$/
      branches << {"kind"=>"unless", "expression"=>$1.strip, "line"=>ln} if l =~ /\bunless\s+(.+)$/
      branches << {"kind"=>"case", "expression"=>$1.strip, "line"=>ln} if l =~ /\bcase\s+(.+)$/
      returns << {"expression"=>$1.strip, "line"=>ln} if l =~ /\breturn\s+(.+)$/
    end
    units << {"symbol"=>name, "kind"=>"RipperDef", "signature"=>line.strip, "returnType"=>"unknown", "parameters"=>params, "lineStart"=>idx+1, "lineEnd"=>end_line, "branches"=>branches, "returns"=>returns, "stateCandidates"=>[]}
  end
end
puts JSON.generate({"units"=>units, "parser"=>"ripper", "sexpAvailable"=>!sexp.nil?})
`;
  }
  if (language === "java") {
    return String.raw`
import java.io.*;
import java.nio.file.*;
import java.util.*;
import javax.tools.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;

public class UnitVerifyJavaAstAdapter {
  static String esc(String s) { return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", " ").replace("\n", " "); }
  static void appendField(StringBuilder out, String key, String value, boolean comma) {
    if (comma) out.append(",");
    out.append("\"").append(key).append("\":\"").append(esc(value)).append("\"");
  }
  static long line(CompilationUnitTree cu, Tree tree) {
    long pos = Trees.instance(task).getSourcePositions().getStartPosition(cu, tree);
    return pos < 0 ? 1 : cu.getLineMap().getLineNumber(pos);
  }
  static long endLine(CompilationUnitTree cu, Tree tree) {
    long pos = Trees.instance(task).getSourcePositions().getEndPosition(cu, tree);
    return pos < 0 ? line(cu, tree) : cu.getLineMap().getLineNumber(pos);
  }
  static JavacTask task;
  static void addBranch(StringBuilder sb, String kind, String expr, long line, boolean[] first) {
    if (!first[0]) sb.append(",");
    first[0] = false;
    sb.append("{\"kind\":\"").append(kind).append("\",\"expression\":\"").append(esc(expr)).append("\",\"line\":").append(line).append("}");
  }
  static void addReturn(StringBuilder sb, String expr, long line, boolean[] first) {
    if (!first[0]) sb.append(",");
    first[0] = false;
    sb.append("{\"expression\":\"").append(esc(expr)).append("\",\"line\":").append(line).append("}");
  }
  static void addState(StringBuilder sb, String target, String op, String value, long line, boolean[] first) {
    if (!first[0]) sb.append(",");
    first[0] = false;
    sb.append("{\"target\":\"").append(esc(target)).append("\",\"operator\":\"").append(esc(op)).append("\",\"value\":\"").append(esc(value)).append("\",\"line\":").append(line).append("}");
  }
  public static void main(String[] args) throws Exception {
    Path path = Paths.get(args[0]);
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) throw new IllegalStateException("JDK javac compiler is unavailable.");
    DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
    StandardJavaFileManager fm = compiler.getStandardFileManager(diagnostics, null, null);
    Iterable<? extends JavaFileObject> files = fm.getJavaFileObjectsFromPaths(List.of(path));
    task = (JavacTask) compiler.getTask(null, fm, diagnostics, List.of("-proc:none"), null, files);
    Iterable<? extends CompilationUnitTree> parsed = task.parse();
    StringBuilder out = new StringBuilder();
    out.append("{\"units\":[");
    boolean[] firstUnitRef = new boolean[]{true};
    for (CompilationUnitTree cu : parsed) {
      new TreeScanner<Void, Void>() {
        @Override public Void visitMethod(MethodTree mt, Void unused) {
          if (mt.getBody() == null) return null;
          if (!firstUnitRef[0]) out.append(",");
          firstUnitRef[0] = false;
          out.append("{");
          appendField(out, "symbol", mt.getName().toString(), false);
          appendField(out, "kind", "JavacMethodTree", true);
          appendField(out, "signature", mt.getName().toString() + mt.getParameters().toString(), true);
          appendField(out, "returnType", mt.getReturnType() == null ? "constructor" : mt.getReturnType().toString(), true);
          out.append(",\"parameters\":[");
          boolean firstParam = true;
          for (VariableTree p : mt.getParameters()) {
            if (!firstParam) out.append(",");
            firstParam = false;
            out.append("{\"name\":\"").append(esc(p.getName().toString())).append("\",\"type\":\"").append(esc(p.getType().toString())).append("\",\"role\":\"input\",\"raw\":\"").append(esc(p.toString())).append("\"}");
          }
          out.append("],\"lineStart\":").append(line(cu, mt)).append(",\"lineEnd\":").append(endLine(cu, mt)).append(",\"branches\":[");
          boolean[] firstBranch = new boolean[]{true};
          StringBuilder returns = new StringBuilder();
          boolean[] firstReturn = new boolean[]{true};
          StringBuilder states = new StringBuilder();
          boolean[] firstState = new boolean[]{true};
          new TreeScanner<Void, Void>() {
            @Override public Void visitIf(IfTree t, Void u) { addBranch(out, "IfTree", String.valueOf(t.getCondition()), line(cu, t), firstBranch); return super.visitIf(t, u); }
            @Override public Void visitWhileLoop(WhileLoopTree t, Void u) { addBranch(out, "WhileLoopTree", String.valueOf(t.getCondition()), line(cu, t), firstBranch); return super.visitWhileLoop(t, u); }
            @Override public Void visitForLoop(ForLoopTree t, Void u) { addBranch(out, "ForLoopTree", String.valueOf(t.getCondition()), line(cu, t), firstBranch); return super.visitForLoop(t, u); }
            @Override public Void visitEnhancedForLoop(EnhancedForLoopTree t, Void u) { addBranch(out, "EnhancedForLoopTree", String.valueOf(t.getExpression()), line(cu, t), firstBranch); return super.visitEnhancedForLoop(t, u); }
            @Override public Void visitSwitch(SwitchTree t, Void u) { addBranch(out, "SwitchTree", String.valueOf(t.getExpression()), line(cu, t), firstBranch); return super.visitSwitch(t, u); }
            @Override public Void visitCase(CaseTree t, Void u) { addBranch(out, "CaseTree", String.valueOf(t.getExpressions()), line(cu, t), firstBranch); return super.visitCase(t, u); }
            @Override public Void visitReturn(ReturnTree t, Void u) { addReturn(returns, String.valueOf(t.getExpression()), line(cu, t), firstReturn); return super.visitReturn(t, u); }
            @Override public Void visitThrow(ThrowTree t, Void u) { addReturn(returns, "throw " + String.valueOf(t.getExpression()), line(cu, t), firstReturn); return super.visitThrow(t, u); }
            @Override public Void visitAssignment(AssignmentTree t, Void u) {
              String lhs = String.valueOf(t.getVariable());
              if (lhs.contains(".") || lhs.startsWith("this.")) addState(states, lhs, "=", String.valueOf(t.getExpression()), line(cu, t), firstState);
              return super.visitAssignment(t, u);
            }
            @Override public Void visitCompoundAssignment(CompoundAssignmentTree t, Void u) {
              String lhs = String.valueOf(t.getVariable());
              if (lhs.contains(".") || lhs.startsWith("this.")) addState(states, lhs, t.getKind().toString(), String.valueOf(t.getExpression()), line(cu, t), firstState);
              return super.visitCompoundAssignment(t, u);
            }
          }.scan(mt.getBody(), null);
          out.append("],\"returns\":[").append(returns).append("],\"stateCandidates\":[").append(states).append("]}");
          return null;
        }
      }.scan(cu, null);
    }
    out.append("]}");
    System.out.println(out.toString());
  }
}
`;
  }
  if (language === "js" || language === "ts") {
    return String.raw`
const fs = require("fs");
let ts;
try { ts = require("typescript"); } catch {
  try { ts = require(process.env.APPDATA + "\\npm\\node_modules\\typescript"); } catch (error) {
    console.error(String(error)); process.exit(2);
  }
}
const path = process.argv[2];
const src = fs.readFileSync(path, "utf8");
const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const units = [];
function loc(node) { return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1; }
function endLoc(node) { return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1; }
function text(node) { return node.getText(sf).replace(/\s+/g, " ").slice(0, 300); }
function params(node) { return (node.parameters || []).map(p => ({ name: p.name.getText(sf), type: p.type ? p.type.getText(sf) : "unknown", role: "input", raw: p.getText(sf) })); }
function visitFunction(node, name, kind) {
  const branches = [], returns = [], states = [];
  function walk(n) {
    if (ts.isIfStatement(n) || ts.isWhileStatement(n) || ts.isForStatement(n) || ts.isSwitchStatement(n)) branches.push({ kind: ts.SyntaxKind[n.kind], expression: text(n.expression || n), line: loc(n) });
    if (ts.isCaseClause(n)) branches.push({ kind: "CaseClause", expression: text(n.expression), line: loc(n) });
    if (ts.isReturnStatement(n)) returns.push({ expression: n.expression ? text(n.expression) : "undefined", line: loc(n) });
    if (ts.isThrowStatement(n)) returns.push({ expression: n.expression ? "throw " + text(n.expression) : "throw", line: loc(n) });
    if (ts.isBinaryExpression(n) && ["FirstAssignment","EqualsToken","PlusEqualsToken","MinusEqualsToken"].includes(ts.SyntaxKind[n.operatorToken.kind]) && /\\.|this\\./.test(text(n.left))) states.push({ target: text(n.left), operator: ts.SyntaxKind[n.operatorToken.kind], value: text(n.right), line: loc(n) });
    ts.forEachChild(n, walk);
  }
  walk(node.body || node);
  units.push({ symbol: name, kind, signature: text(node).replace(/\{.*$/s, "").trim(), returnType: node.type ? node.type.getText(sf) : "unknown", parameters: params(node), lineStart: loc(node), lineEnd: endLoc(node), branches, returns, stateCandidates: states });
}
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) visitFunction(node, node.name.text, "FunctionDeclaration");
  if (ts.isMethodDeclaration(node) && node.name) visitFunction(node, node.name.getText(sf), "MethodDeclaration");
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) visitFunction(node.initializer, node.name.getText(sf), "FunctionVariable");
  ts.forEachChild(node, visit);
}
visit(sf);
console.log(JSON.stringify({ units }));
`;
  }
  return null;
}

function runExternalAstAdapter({ sourcePath, relativeFile, text, language, symbols }) {
  const tool = externalAdapterTool(language);
  const script = adapterScriptForLanguage(language);
  if (!tool || !script) return { units: [], diagnostics: [{ severity: "info", code: "ast_adapter_unavailable", message: `No AST adapter is configured for ${language}.`, source: "mcp" }], used: false };
  const tmpDir = os.tmpdir();
  const ext = language === "go" ? ".go" : language === "ruby" ? ".rb" : language === "js" || language === "ts" ? ".js" : language === "java" ? ".java" : ".py";
  const scriptName = language === "java" ? "UnitVerifyJavaAstAdapter" : `unitverify-${language}-ast-${process.pid}-${Date.now()}`;
  const scriptPath = path.join(tmpDir, `${scriptName}${ext}`);
  try {
    writeFileSync(scriptPath, script, "utf8");
  } catch (error) {
    return { units: [], diagnostics: [{ severity: "warning", code: "ast_adapter_write_failed", message: String(error), source: "mcp" }], used: false };
  }
  let commandArgs = language === "go" ? ["run", scriptPath, "--", sourcePath] : [scriptPath, sourcePath];
  let commandTool = tool;
  let cleanupPaths = [scriptPath];
  if (language === "java") {
    const compile = spawnSync(tool, [scriptPath], { cwd: tmpDir, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    if (compile.status !== 0) {
      try { unlinkSync(scriptPath); } catch {}
      return { units: [], diagnostics: [{ severity: "warning", code: "java_ast_adapter_compile_failed", message: truncate(compile.stderr || compile.stdout || "", 4000), source: "mcp" }], used: false };
    }
    commandTool = resolveTool("java") || "java";
    commandArgs = ["-cp", tmpDir, "UnitVerifyJavaAstAdapter", sourcePath];
    cleanupPaths.push(path.join(tmpDir, "UnitVerifyJavaAstAdapter.class"));
  }
  let result = null;
  if (language === "java") {
    result = spawnSync(commandTool, commandArgs, {
      cwd: tmpDir,
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
  } else {
    result = spawnSync(tool, commandArgs, {
      cwd: path.dirname(sourcePath),
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true
    });
  }
  for (const cleanupPath of cleanupPaths) {
    try { unlinkSync(cleanupPath); } catch {}
  }
  if (result.status !== 0 || !result.stdout) {
    return {
      units: [],
      diagnostics: [{ severity: "warning", code: `${language}_ast_adapter_failed`, message: truncate(result.stderr || result.stdout || "AST adapter failed.", 4000), source: "mcp" }],
      used: false
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { units: [], diagnostics: [{ severity: "warning", code: `${language}_ast_adapter_json_failed`, message: String(error), source: "mcp" }], used: false };
  }
  const symbolSet = new Set((symbols || []).filter(Boolean));
  const units = (parsed.units || [])
    .filter((unit) => !symbolSet.size || symbolSet.has(unit.symbol))
    .map((unit) => {
      const unitId = `${slug(path.basename(relativeFile, path.extname(relativeFile)))}.${slug(unit.symbol)}`;
      const lineStart = unit.lineStart || 1;
      const branches = (unit.branches || []).map((branch, index) => ({
        branchId: `${unitId}-br-${index + 1}`,
        unitId,
        symbol: unit.symbol,
        kind: branch.kind || "branch",
        expression: branch.expression || "",
        sourceRef: sourceRef(relativeFile, branch.line || lineStart),
        evidence: `${language} AST ${branch.kind || "branch"} at ${sourceRef(relativeFile, branch.line || lineStart)}: ${branch.expression || ""}`,
        reviewStatus: "needs_review",
        origin: `${language}-ast-adapter`
      }));
      const returns = (unit.returns || []).map((item, index) => ({
        returnId: `${unitId}-ret-${index + 1}`,
        unitId,
        expression: item.expression || "",
        sourceRef: sourceRef(relativeFile, item.line || lineStart),
        evidence: `${language} AST return/error path at ${sourceRef(relativeFile, item.line || lineStart)}: ${item.expression || ""}`,
        origin: `${language}-ast-adapter`
      }));
      const stateCandidates = (unit.stateCandidates || []).map((item, index) => ({
        stateId: `${unitId}-state-${index + 1}`,
        unitId,
        target: item.target || "",
        operator: item.operator || "=",
        value: item.value || "",
        sourceRef: sourceRef(relativeFile, item.line || lineStart),
        evidence: `${language} AST state-like assignment at ${sourceRef(relativeFile, item.line || lineStart)}: ${item.target || ""}`,
        reviewStatus: "needs_review",
        origin: `${language}-ast-adapter`
      }));
      return {
        unitId,
        language,
        file: sourcePath,
        relativeFile,
        symbol: unit.symbol,
        kind: unit.kind || "function",
        signature: unit.signature || unit.symbol,
        returnType: unit.returnType || "unknown",
        parameters: unit.parameters || [],
        lineStart,
        lineEnd: unit.lineEnd || lineStart,
        sourceRef: sourceRef(relativeFile, lineStart),
        evidence: `${language} AST ${unit.kind || "function"} at ${sourceRef(relativeFile, lineStart)}: ${unit.signature || unit.symbol}`,
        branches,
        returns,
        stateCandidates,
        extractionBackend: `${language}-ast-adapter`
      };
    });
  return { units, diagnostics: [], used: units.length > 0, backend: `${language}-ast-adapter` };
}

function extractSourceUnits({ sourcePath, relativeFile, text, language, symbols }) {
  const lines = String(text || "").split(/\r?\n/);
  const symbolSet = new Set((symbols || []).filter(Boolean));
  const units = [];
  const diagnostics = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmed = stripInlineComment(lines[lineIndex], language).trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    let window = "";
    let signature = null;
    let windowEnd = lineIndex;
    const windowLimit = language === "python" || language === "ruby" ? 1 : 8;
    for (let cursor = lineIndex; cursor < Math.min(lines.length, lineIndex + windowLimit); cursor += 1) {
      window = `${window} ${stripInlineComment(lines[cursor], language).trim()}`.trim();
      signature = matchSourceSignature(window, language);
      windowEnd = cursor;
      if (signature || (window.includes("{") && !window.includes("("))) break;
    }
    if (!signature) continue;
    if (symbolSet.size > 0 && !symbolSet.has(signature.symbol)) continue;
    const unitId = `${slug(path.basename(relativeFile, path.extname(relativeFile)))}.${slug(signature.symbol)}`;
    if (units.some((item) => item.unitId === unitId)) continue;
    const endLine = language === "python" || language === "ruby" ? findIndentedBlockEnd(lines, lineIndex) : findBraceBlockEnd(lines, windowEnd);
    const params = parseSourceParameters(signature.params, language);
    const bodyLines = lines.slice(lineIndex, endLine + 1);
    const branches = extractConditionsFromBody({ unitId, symbol: signature.symbol, lineStart: lineIndex + 1 }, bodyLines, relativeFile, language);
    const returns = extractReturnsFromBody({ unitId, symbol: signature.symbol, lineStart: lineIndex + 1 }, bodyLines, relativeFile, language);
    const stateCandidates = extractStateCandidatesFromBody({ unitId, symbol: signature.symbol, lineStart: lineIndex + 1 }, bodyLines, relativeFile, language);
    units.push({
      unitId,
      language,
      file: sourcePath,
      relativeFile,
      symbol: signature.symbol,
      kind: signature.kind,
      signature: window.replace(/\s*\{.*$/, "").trim(),
      returnType: signature.returnType,
      parameters: params,
      lineStart: lineIndex + 1,
      lineEnd: endLine + 1,
      sourceRef: sourceRef(relativeFile, lineIndex + 1),
      evidence: `Signature at ${sourceRef(relativeFile, lineIndex + 1)}: ${window.replace(/\s*\{.*$/, "").trim()}`,
      branches,
      returns,
      stateCandidates
    });
    lineIndex = Math.max(lineIndex, endLine);
  }
  if (symbolSet.size > 0) {
    for (const requested of symbolSet) {
      if (!units.some((unit) => unit.symbol === requested)) {
        diagnostics.push({
          severity: "warning",
          code: "source_symbol_not_found",
          message: `Requested symbol '${requested}' was not found in ${relativeFile}.`,
          source: "mcp"
        });
      }
    }
  }
  return { units, diagnostics };
}

function buildSourceDerivedArtifacts({ projectRoot, units, branches, stateCandidates, inputOutputCandidates, language, sourceFiles, includeAssertions, includeOracles }) {
  const now = new Date().toISOString();
  const requirements = units.map((unit) => ({
    requirementId: `SRC-REQ-${unit.unitId}`,
    text: `Source-derived draft requirement for ${unit.symbol}: preserve behavior implied by the implementation signature and observed control flow.`,
    sourceRef: unit.sourceRef,
    evidence: unit.evidence,
    reviewStatus: "inferred",
    confidence: 0.35,
    origin: "source-derived"
  }));
  const specUnits = units.map((unit) => ({
    unitId: unit.unitId,
    language: unit.language,
    file: unit.file,
    symbol: unit.symbol,
    signature: unit.signature,
    returnType: unit.returnType,
    inputs: unit.parameters.filter((param) => param.role === "input"),
    outputs: [
      ...(unit.returnType && !["void", "()"].includes(unit.returnType) ? [{ name: "return", type: unit.returnType, role: "return" }] : []),
      ...unit.parameters.filter((param) => param.role === "output_or_state")
    ],
    states: unit.stateCandidates,
    constraints: unit.branches.map((branch) => ({ expression: branch.expression, sourceRef: branch.sourceRef })),
    sourceRef: unit.sourceRef,
    evidence: unit.evidence,
    reviewStatus: "inferred",
    confidence: 0.45,
    origin: "source-derived"
  }));
  const specAnalysis = {
    schemaVersion: "unitverify.spec-analysis.v1",
    analysisId: `source-derived-${Date.now()}`,
    sourceDocuments: sourceFiles.map((filePath) => ({ path: path.relative(projectRoot, filePath), kind: "source-code" })),
    requirements,
    units: specUnits,
    assumptions: [
      {
        assumptionId: "source-derived-draft",
        text: "This unit design was inferred from source code and is not an authoritative requirement until reviewed.",
        reviewStatus: "needs_review",
        evidence: "Generated by unitverify_extract_design_from_source."
      }
    ],
    createdAt: now
  };
  const decisionTables = units.map((unit) => ({
    tableId: `${unit.unitId}-decision-table`,
    unitId: unit.unitId,
    requirementId: `SRC-REQ-${unit.unitId}`,
    title: `Source-derived decision table draft for ${unit.symbol}`,
    conditions: unit.branches.map((branch) => ({
      conditionId: branch.branchId,
      expression: branch.expression,
      kind: branch.kind,
      sourceRef: branch.sourceRef,
      evidence: branch.evidence
    })),
    rules: unit.branches.flatMap((branch, index) => [
      {
        ruleId: `${branch.branchId}-true`,
        conditionId: branch.branchId,
        expectedPath: "condition true path",
        reviewStatus: "needs_review",
        sourceRef: branch.sourceRef,
        evidence: branch.evidence,
        order: index * 2 + 1
      },
      {
        ruleId: `${branch.branchId}-false`,
        conditionId: branch.branchId,
        expectedPath: "condition false path",
        reviewStatus: "needs_review",
        sourceRef: branch.sourceRef,
        evidence: branch.evidence,
        order: index * 2 + 2
      }
    ]),
    reviewStatus: unit.branches.length > 0 ? "needs_review" : "missing",
    confidence: unit.branches.length > 0 ? 0.45 : 0.2,
    sourceRef: unit.sourceRef,
    evidence: unit.branches.length > 0 ? `Derived from ${unit.branches.length} branch candidates.` : "No branch candidates were found in source.",
    origin: "source-derived"
  }));
  const boundaryValues = [];
  const equivalencePartitions = [];
  const undefinedBehaviorCorners = [];
  const abnormalBehaviorCorners = [];
  for (const unit of units) {
    const derived = deriveBoundaryAndEquivalence(unit, unit.branches);
    boundaryValues.push(...derived.boundaryValues);
    equivalencePartitions.push(...derived.equivalencePartitions);
    undefinedBehaviorCorners.push(...deriveUndefinedBehaviorRisks(unit));
    abnormalBehaviorCorners.push(...deriveAbnormalBehaviorRisks(unit));
  }
  const testCases = [];
  for (const unit of units) {
    testCases.push({
      testcaseId: `${unit.unitId}-coverage-growth-tc`,
      requirementId: `SRC-REQ-${unit.unitId}`,
      unitId: unit.unitId,
      name: `Coverage-growth testcase seed for ${unit.symbol}`,
      designMethod: "coverage_growth",
      inputs: {},
      oracleRef: `${unit.unitId}-oracle-missing`,
      expected: {},
      designReason: "Always execute a coding-agent coverage-growth testcase after the baseline run, even when only source code was provided.",
      sourceBasis: unit.sourceRef,
      executionCategory: "coverage-growth",
      reviewStatus: "needs_review",
      confidence: 0.3,
      evidence: unit.evidence,
      source: "source-derived"
    });
  }
  for (const branch of branches) {
    testCases.push({
      testcaseId: `${branch.branchId}-true-tc`,
      requirementId: `SRC-REQ-${branch.unitId}`,
      unitId: branch.unitId,
      name: `Exercise true path for ${branch.expression}`,
      designMethod: "decision_table",
      inputs: {},
      oracleRef: `${branch.branchId}-oracle`,
      expected: {},
      reviewStatus: "needs_review",
      confidence: 0.35,
      evidence: branch.evidence,
      source: "source-derived"
    });
    testCases.push({
      testcaseId: `${branch.branchId}-false-tc`,
      requirementId: `SRC-REQ-${branch.unitId}`,
      unitId: branch.unitId,
      name: `Exercise false path for ${branch.expression}`,
      designMethod: "decision_table",
      inputs: {},
      oracleRef: `${branch.branchId}-oracle`,
      expected: {},
      reviewStatus: "needs_review",
      confidence: 0.35,
      evidence: branch.evidence,
      source: "source-derived"
    });
  }
  for (const boundary of boundaryValues) {
    testCases.push({
      testcaseId: `${boundary.boundaryId}-tc`,
      requirementId: `SRC-REQ-${boundary.unitId}`,
      unitId: boundary.unitId,
      name: `Boundary-value testcase for ${boundary.variable}`,
      designMethod: "boundary_value",
      inputs: { [boundary.variable]: boundary.candidates || [] },
      oracleRef: `${boundary.boundaryId}-oracle-missing`,
      expected: {},
      designReason: "Boundary-value testcase is mandatory for source-only verification; values are inferred from comparison boundary candidates.",
      sourceBasis: boundary.sourceRef,
      executionCategory: "boundary-value",
      reviewStatus: "needs_review",
      confidence: boundary.confidence ?? 0.35,
      evidence: boundary.evidence,
      source: "source-derived"
    });
  }
  for (const partition of equivalencePartitions) {
    testCases.push({
      testcaseId: `${partition.partitionId}-tc`,
      requirementId: `SRC-REQ-${partition.unitId}`,
      unitId: partition.unitId,
      name: `Equivalence-partition testcase for ${partition.variable}`,
      designMethod: "equivalence_partition",
      inputs: { representative: partition.representative, classes: partition.classes || [] },
      oracleRef: `${partition.partitionId}-oracle-missing`,
      expected: {},
      designReason: "Equivalence-partition testcase is mandatory for source-only verification; representative classes are inferred from guards or comparisons.",
      sourceBasis: partition.sourceRef,
      executionCategory: "equivalence-partition",
      reviewStatus: "needs_review",
      confidence: partition.confidence ?? 0.35,
      evidence: partition.evidence,
      source: "source-derived"
    });
  }
  for (const ubCase of undefinedBehaviorCorners) {
    testCases.push({
      testcaseId: `${ubCase.ubCaseId}-tc`,
      requirementId: `SRC-REQ-${ubCase.unitId}`,
      unitId: ubCase.unitId,
      name: `UB corner-case review testcase for ${ubCase.symbol}`,
      designMethod: "undefined_behavior_corner",
      inputs: {},
      oracleRef: `${ubCase.ubCaseId}-oracle-missing`,
      expected: {},
      designReason: "Generate and execute this testcase only if coding-agent source review confirms the UB risk is plausible.",
      sourceBasis: ubCase.sourceRef,
      executionCategory: "ub-corner-case",
      expectedRisk: ubCase.expectedRisk,
      reviewStatus: "needs_review",
      confidence: ubCase.confidence,
      evidence: ubCase.evidence,
      source: "source-derived"
    });
  }
  for (const abCase of abnormalBehaviorCorners) {
    testCases.push({
      testcaseId: `${abCase.abCaseId}-tc`,
      requirementId: `SRC-REQ-${abCase.unitId}`,
      unitId: abCase.unitId,
      name: `Abnormal-behavior review testcase for ${abCase.symbol}`,
      designMethod: "abnormal_behavior_corner",
      inputs: {},
      oracleRef: `${abCase.abCaseId}-oracle-missing`,
      expected: {},
      designReason: "Generate and execute this testcase only if coding-agent review confirms the abnormal behavior risk is plausible.",
      sourceBasis: abCase.sourceRef,
      executionCategory: "abnormal-behavior-corner-case",
      expectedRisk: abCase.expectedRisk,
      reviewStatus: "needs_review",
      confidence: abCase.confidence,
      evidence: abCase.evidence,
      source: "source-derived"
    });
  }
  const testDesign = {
    schemaVersion: "unitverify.test-design.v1",
    designId: `source-derived-design-${Date.now()}`,
    language,
    source: { kind: "source-code", files: sourceFiles.map((filePath) => path.relative(projectRoot, filePath)), origin: "source-derived" },
    testCases,
    manualTestCases: [],
    decisionTables,
    stateModels: stateCandidates.length > 0 ? [{
      modelId: "source-derived-state-candidates",
      title: "State-like assignment candidates",
      states: stateCandidates.map((item) => ({ stateId: item.stateId, target: item.target, sourceRef: item.sourceRef, evidence: item.evidence })),
      reviewStatus: "needs_review",
      evidence: "Derived from assignments to object, struct, self, or this fields."
    }] : [],
    boundaryValues,
    equivalencePartitions,
    undefinedBehaviorCorners,
    abnormalBehaviorCorners,
    testTechniqueSummary: buildTestTechniqueSummary({
      hasStateCandidates: stateCandidates.length > 0,
      hasUndefinedBehaviorRisks: undefinedBehaviorCorners.length > 0,
      hasAbnormalBehaviorRisks: abnormalBehaviorCorners.length > 0
    }),
    createdAt: now
  };
  const assertions = includeAssertions ? branches.map((branch) => ({
    assertionId: `${branch.branchId}-precondition`,
    requirementId: `SRC-REQ-${branch.unitId}`,
    unitId: branch.unitId,
    kind: "precondition",
    expression: branch.expression,
    location: branch.sourceRef,
    reviewStatus: "needs_review",
    confidence: 0.35,
    evidence: `Guard-like condition extracted from source: ${branch.evidence}`,
    origin: "source-derived"
  })) : [];
  const assertionArtifact = {
    schemaVersion: "unitverify.assertion.v1",
    assertionSetId: `source-derived-assertions-${Date.now()}`,
    language,
    assertions
  };
  const oracles = includeOracles ? units.flatMap((unit) => {
    if (!unit.returns.length) {
      return [{
        oracleId: `${unit.unitId}-oracle-missing`,
        requirementId: `SRC-REQ-${unit.unitId}`,
        unitId: unit.unitId,
        expectedReturn: undefined,
        comparator: "custom",
        reviewStatus: "missing",
        confidence: 0,
        evidence: `No explicit return or throw expression found for ${unit.symbol}.`,
        origin: "source-derived"
      }];
    }
    return unit.returns.map((item) => {
      const literal = literalReturnValue(item.expression);
      const hasLiteral = literal !== undefined;
      return {
        oracleId: `${item.returnId}-oracle`,
        requirementId: `SRC-REQ-${unit.unitId}`,
        unitId: unit.unitId,
        expectedReturn: hasLiteral ? literal : undefined,
        comparator: hasLiteral ? "exact" : "custom",
        reviewStatus: hasLiteral ? "inferred" : "needs_review",
        confidence: hasLiteral ? 0.5 : 0.25,
        evidence: hasLiteral ? item.evidence : `${item.evidence}. Expected value requires review because it is expression-derived.`,
        origin: "source-derived",
        expression: item.expression
      };
    });
  }) : [];
  const oracleArtifact = {
    schemaVersion: "unitverify.oracle.v1",
    oracleSetId: `source-derived-oracles-${Date.now()}`,
    language,
    oracles
  };
  return { specAnalysis, testDesign, assertionArtifact, oracleArtifact };
}

function summarizeReviewStatusFromArtifacts(artifacts) {
  const rows = artifacts.flatMap((artifact) => reviewRowsForArtifact(artifact));
  const counts = countByStatus(rows);
  return {
    specified: counts.specified || 0,
    inferred: counts.inferred || 0,
    missing: counts.missing || 0,
    needs_review: counts.needs_review || 0,
    approved: counts.approved || 0,
    rejected: counts.rejected || 0,
    unspecified: counts.unspecified || 0
  };
}

function readBundledUnitDesignTemplate() {
  const candidates = [
    path.join(pluginRoot, "assets", "templates", "PerfectOne_UnitDesign_Template_v1_5.md"),
    path.join(pluginRoot, "assets", "templates", "PerfectOne_UnitDesign_Template_v1_4.md"),
    path.join(pluginRoot, "assets", "templates", "PerfectOne_UnitDesign_Template_v1_3.md")
  ];
  for (const candidate of candidates) {
    if (pathExists(candidate)) return { path: candidate, text: readSmallTextSync(candidate, 2 * MAX_OUTPUT) };
  }
  return { path: null, text: "# <unit_slug> Unit Design\n\n<!-- PERFECTONE:UNIT_META slug=\"<unit_slug>\" source=\"<rel/path/to/file>\" -->\n" };
}

function renderUnitDesignMarkdownFromTemplate({ projectRoot, sourceFiles, units, specAnalysis, testDesign, origin }) {
  const template = readBundledUnitDesignTemplate();
  const firstSource = sourceFiles?.[0] || "";
  const relativeSource = firstSource ? path.relative(projectRoot, firstSource) || path.basename(firstSource) : "specification";
  const unitSlug = slug(path.basename(relativeSource, path.extname(relativeSource)) || "unit-design");
  let markdown = template.text || "";
  markdown = markdown.replace(/<unit_slug>/g, unitSlug);
  markdown = markdown.replace(/<rel\/path\/to\/file>/g, relativeSource.replace(/\\/g, "/"));
  markdown = markdown.replace(/<YYYY-MM-DD>/g, new Date().toISOString().slice(0, 10));
  markdown = markdown.replace(/<unit>/g, unitSlug);
  markdown = markdown.replace(/<\?[^>]*file[^>]*>/g, path.basename(relativeSource));
  const requirements = specAnalysis?.requirements || [];
  const decisionTables = testDesign?.decisionTables || [];
  const stateModels = testDesign?.stateModels || [];
  const boundaryValues = testDesign?.boundaryValues || [];
  const equivalencePartitions = testDesign?.equivalencePartitions || [];
  const testCases = testDesign?.testCases || [];
  const append = [
    "",
    "<!-- PERFECTONE:CODEX_UNITVERIFY_GENERATED_BEGIN -->",
    "## Codex Unit Design Artifact Summary",
    "",
    `- Origin: ${origin || "unknown"}`,
    `- Template: ${template.path ? path.basename(template.path) : "fallback"}`,
    `- Requirements: ${requirements.length}`,
    `- Units: ${(units || specAnalysis?.units || []).length}`,
    `- Testcases: ${testCases.length}`,
    `- Decision tables: ${decisionTables.length}`,
    `- State models: ${stateModels.length}`,
    `- Boundary values: ${boundaryValues.length}`,
    `- Equivalence partitions: ${equivalencePartitions.length}`,
    "",
    "### Generated Requirements",
    "",
    "| ID | Status | Evidence | Text |",
    "|---|---|---|---|",
    ...requirements.map((item) => `| ${item.requirementId || ""} | ${item.reviewStatus || ""} | ${htmlEscape(item.sourceRef || item.evidence || "").replace(/\|/g, "\\|")} | ${htmlEscape(item.text || "").replace(/\|/g, "\\|")} |`),
    "",
    "### Generated Testcases",
    "",
    "| ID | Method | Unit | Status | Reason |",
    "|---|---|---|---|---|",
    ...testCases.map((item) => `| ${item.testcaseId || ""} | ${item.designMethod || ""} | ${item.unitId || ""} | ${item.reviewStatus || ""} | ${htmlEscape(item.designReason || item.evidence || "").replace(/\|/g, "\\|")} |`),
    "<!-- PERFECTONE:CODEX_UNITVERIFY_GENERATED_END -->",
    ""
  ];
  return markdown.trimEnd() + "\n" + append.join("\n");
}

function specSourceRef(sourceName, lineNumber) {
  return `${sourceName || "spec"}:${lineNumber || 1}`;
}

function splitSpecLines(specText) {
  return String(specText || "")
    .split(/\r?\n/)
    .map((line, index) => ({ raw: line, text: line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim(), line: index + 1 }))
    .filter((item) => item.text && !/^#{1,6}\s*$/.test(item.text));
}

function inferSpecUnits(targetUnits, requirements, language) {
  const units = [];
  for (const item of targetUnits || []) {
    if (typeof item === "string") {
      units.push({ unitId: slug(item), language, symbol: item, signature: item, reviewStatus: "specified", evidence: "User-provided target unit." });
    } else if (item && typeof item === "object") {
      const symbol = item.symbol || item.name || item.unitId || "unit";
      units.push({ unitId: item.unitId || slug(symbol), language, symbol, signature: item.signature || symbol, reviewStatus: item.reviewStatus || "specified", evidence: item.evidence || "User-provided target unit.", ...item });
    }
  }
  if (units.length > 0) return units;
  const seen = new Set();
  for (const req of requirements) {
    const match = req.text.match(/\b(?:function|method|unit)\s+([A-Za-z_][A-Za-z0-9_.$:-]*)/i);
    const symbol = match?.[1];
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    units.push({
      unitId: slug(symbol),
      language,
      symbol,
      signature: symbol,
      reviewStatus: "inferred",
      evidence: `Inferred target unit from ${req.sourceRef}.`
    });
  }
  if (units.length === 0) {
    units.push({
      unitId: "spec.unit",
      language,
      symbol: "spec-derived-unit",
      signature: "spec-derived-unit",
      reviewStatus: "needs_review",
      evidence: "No explicit unit was found in the specification; created a review placeholder."
    });
  }
  return units;
}

function extractSpecRequirements(specText, sourceName) {
  const lines = splitSpecLines(specText);
  const requirementLines = lines.filter((item) =>
    /\b(shall|must|should|required|requirement|REQ-|when|if|given|then|state|transition|return|output|input|valid|invalid)\b/i.test(item.text)
  );
  const selected = requirementLines.length ? requirementLines : lines;
  return selected.map((item, index) => {
    const idMatch = item.text.match(/^\s*\[?((?:REQ|SRS)[-_]?\d+[A-Za-z0-9_-]*)\]?\s*[:.-]?\s*(.*)$/i);
    const requirementId = idMatch?.[1] || `SPEC-REQ-${String(index + 1).padStart(3, "0")}`;
    const text = (idMatch?.[2] || item.text).trim() || item.text;
    return {
      requirementId,
      text,
      sourceRef: specSourceRef(sourceName, item.line),
      evidence: `Specification line ${item.line}: ${text}`,
      reviewStatus: "specified",
      confidence: 0.9,
      origin: "specification"
    };
  });
}
function extractSpecConditions(text) {
  const conditions = [];
  const patterns = [
    /\bif\s+([^,.]+)[,.]?/ig,
    /\bwhen\s+([^,.]+)[,.]?/ig,
    /\bgiven\s+([^,.]+)[,.]?/ig,
    /\bunless\s+([^,.]+)[,.]?/ig
  ];
  for (const pattern of patterns) {
    for (const match of String(text || "").matchAll(pattern)) {
      const expr = match[1]?.trim();
      if (expr && !conditions.includes(expr)) conditions.push(expr);
    }
  }
  return conditions;
}
function extractSpecTransitions(requirements, defaultUnitId) {
  const transitions = [];
  for (const req of requirements) {
    const text = req.text;
    const patterns = [
      /\bfrom\s+([A-Za-z0-9_. -]+?)\s+to\s+([A-Za-z0-9_. -]+?)(?:\s+when\s+([^,.]+))?[,.]?/ig,
      /\b([A-Za-z0-9_.-]+)\s*->\s*([A-Za-z0-9_.-]+)(?:\s*(?:when|if)\s*([^,.]+))?/ig
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const from = match[1]?.trim();
        const to = match[2]?.trim();
        if (!from || !to) continue;
        transitions.push({
          transitionId: `${defaultUnitId}-tr-${transitions.length + 1}`,
          requirementId: req.requirementId,
          from,
          to,
          event: match[3]?.trim() || "unspecified_event",
          guard: match[3]?.trim() || "",
          expectedNextState: to,
          sourceRef: req.sourceRef,
          evidence: req.evidence,
          reviewStatus: match[3] ? "specified" : "needs_review"
        });
      }
    }
  }
  return transitions;
}
function deriveSpecBoundaryAndEquivalence(requirements, units) {
  const boundaryValues = [];
  const equivalencePartitions = [];
  const defaultUnitId = units[0]?.unitId || "spec.unit";
  for (const req of requirements) {
    for (const match of req.text.matchAll(/([A-Za-z_][\w. -]*)\s*(<=|>=|<|>|==|!=)\s*(-?\d+(?:\.\d+)?)/g)) {
      const variable = match[1].trim().replace(/\s+/g, "_");
      const operator = match[2];
      const value = Number(match[3]);
      if (["<", "<=", ">", ">="].includes(operator)) {
        boundaryValues.push({
          boundaryId: `${defaultUnitId}-spec-bnd-${boundaryValues.length + 1}`,
          unitId: defaultUnitId,
          requirementId: req.requirementId,
          variable,
          operator,
          value,
          candidates: [value - 1, value, value + 1],
          sourceRef: req.sourceRef,
          evidence: req.evidence,
          reviewStatus: "specified",
          confidence: 0.75
        });
      }
      equivalencePartitions.push({
        partitionId: `${defaultUnitId}-spec-eq-${equivalencePartitions.length + 1}`,
        unitId: defaultUnitId,
        requirementId: req.requirementId,
        variable,
        operator,
        representative: value,
        classes: [`${variable} ${operator} ${value}`, `${variable} not(${operator}) ${value}`],
        sourceRef: req.sourceRef,
        evidence: req.evidence,
        reviewStatus: "specified",
        confidence: 0.75
      });
    }
    const validInvalid = req.text.match(/\b(valid|invalid)\b/i);
    if (validInvalid) {
      equivalencePartitions.push({
        partitionId: `${defaultUnitId}-spec-eq-${equivalencePartitions.length + 1}`,
        unitId: defaultUnitId,
        requirementId: req.requirementId,
        variable: "input_class",
        operator: "spec-class",
        representative: validInvalid[1],
        classes: ["valid", "invalid"],
        sourceRef: req.sourceRef,
        evidence: req.evidence,
        reviewStatus: "specified",
        confidence: 0.65
      });
    }
  }
  if (boundaryValues.length === 0) {
    boundaryValues.push({
      boundaryId: `${defaultUnitId}-spec-bnd-review`,
      unitId: defaultUnitId,
      variable: "spec_boundary_review",
      operator: "review-required",
      value: null,
      candidates: ["min", "min+1", "nominal", "max-1", "max", "invalid"],
      sourceRef: "spec:review",
      evidence: "Boundary-value testing is mandatory; no explicit numeric boundary was found, so concrete values require review.",
      reviewStatus: "needs_review",
      confidence: 0.2
    });
  }
  if (equivalencePartitions.length === 0) {
    equivalencePartitions.push({
      partitionId: `${defaultUnitId}-spec-eq-review`,
      unitId: defaultUnitId,
      variable: "spec_equivalence_review",
      operator: "review-required",
      representative: "valid_nominal",
      classes: ["valid nominal", "invalid or unsupported"],
      sourceRef: "spec:review",
      evidence: "Equivalence partitioning is mandatory; no explicit classes were found, so concrete classes require review.",
      reviewStatus: "needs_review",
      confidence: 0.2
    });
  }
  return { boundaryValues, equivalencePartitions };
}

function buildSpecDerivedArtifacts({ projectRoot, specText, sourceName, language, targetUnits }) {
  const now = new Date().toISOString();
  const requirements = extractSpecRequirements(specText, sourceName);
  const units = inferSpecUnits(targetUnits, requirements, language);
  const defaultUnitId = units[0]?.unitId || "spec.unit";
  const transitions = extractSpecTransitions(requirements, defaultUnitId);
  const { boundaryValues, equivalencePartitions } = deriveSpecBoundaryAndEquivalence(requirements, units);
  const decisionTables = requirements.map((req, index) => {
    const conditions = extractSpecConditions(req.text);
    const conditionRows = (conditions.length ? conditions : ["review condition/action combination"]).map((condition, cIndex) => ({
      conditionId: `${req.requirementId}-cond-${cIndex + 1}`,
      expression: condition,
      kind: conditions.length ? "spec-condition" : "review-required",
      sourceRef: req.sourceRef,
      evidence: req.evidence
    }));
    return {
      tableId: `${defaultUnitId}-spec-decision-${index + 1}`,
      unitId: defaultUnitId,
      requirementId: req.requirementId,
      title: `Specification-derived decision table for ${req.requirementId}`,
      conditions: conditionRows,
      rules: conditionRows.flatMap((condition, ruleIndex) => [
        { ruleId: `${condition.conditionId}-true`, conditionId: condition.conditionId, expectedPath: "condition true action", reviewStatus: conditions.length ? "specified" : "needs_review", sourceRef: req.sourceRef, evidence: req.evidence, order: ruleIndex * 2 + 1 },
        { ruleId: `${condition.conditionId}-false`, conditionId: condition.conditionId, expectedPath: "condition false or else action", reviewStatus: "needs_review", sourceRef: req.sourceRef, evidence: req.evidence, order: ruleIndex * 2 + 2 }
      ]),
      applicationStatus: conditions.length ? "generated" : "needs_review_no_explicit_conditions",
      reviewStatus: conditions.length ? "specified" : "needs_review",
      confidence: conditions.length ? 0.75 : 0.25,
      sourceRef: req.sourceRef,
      evidence: req.evidence,
      origin: "specification"
    };
  });
  const stateModels = [{
    modelId: `${defaultUnitId}-spec-state-model`,
    unitId: defaultUnitId,
    title: `Specification-derived state transition model for ${defaultUnitId}`,
    states: Array.from(new Set(transitions.flatMap((item) => [item.from, item.to]))).map((state, index) => ({ stateId: `${defaultUnitId}-state-${index + 1}`, name: state, reviewStatus: "specified" })),
    transitions,
    applicationStatus: transitions.length ? "generated" : "not_applicable_no_explicit_state_transitions",
    reviewStatus: transitions.length ? "specified" : "needs_review",
    evidence: transitions.length ? `Derived ${transitions.length} transition candidates from specification.` : "State-transition testing was reviewed, but no explicit state transition was found in the specification.",
    origin: "specification"
  }];
  const manualTestCases = requirements.map((req, index) => ({
    testcaseId: `${req.requirementId}-manual-${index + 1}`,
    requirementId: req.requirementId,
    unitId: defaultUnitId,
    name: `Manual testcase seed for ${req.requirementId}`,
    designMethod: "manual",
    inputs: {},
    oracleRef: `${req.requirementId}-oracle`,
    expected: {},
    designReason: "Specification-derived manual testcase seed for reviewer completion or approval.",
    sourceBasis: req.sourceRef,
    executionCategory: "manual-spec-testcase",
    reviewStatus: "needs_review",
    confidence: 0.4,
    evidence: req.evidence,
    source: "specification"
  }));
  const testCases = [
    ...manualTestCases,
    ...decisionTables.flatMap((table) => table.rules.map((rule) => ({
      testcaseId: `${rule.ruleId}-tc`,
      requirementId: table.requirementId,
      unitId: table.unitId,
      name: `Decision-table testcase for ${rule.ruleId}`,
      designMethod: "decision_table",
      inputs: {},
      oracleRef: `${rule.ruleId}-oracle`,
      expected: {},
      designReason: "Specification-driven decision-table testcase.",
      sourceBasis: rule.sourceRef,
      executionCategory: "spec-decision-table",
      reviewStatus: rule.reviewStatus,
      confidence: table.confidence,
      evidence: rule.evidence,
      source: "specification"
    }))),
    ...transitions.map((transition) => ({
      testcaseId: `${transition.transitionId}-tc`,
      requirementId: transition.requirementId,
      unitId: defaultUnitId,
      name: `State-transition testcase ${transition.from} -> ${transition.to}`,
      designMethod: "state_coverage",
      inputs: { from: transition.from, event: transition.event, guard: transition.guard },
      oracleRef: `${transition.transitionId}-oracle`,
      expected: { nextState: transition.to },
      designReason: "Specification-driven state-transition testcase.",
      sourceBasis: transition.sourceRef,
      executionCategory: "spec-state-transition",
      reviewStatus: transition.reviewStatus,
      confidence: transition.guard ? 0.75 : 0.45,
      evidence: transition.evidence,
      source: "specification"
    })),
    ...boundaryValues.map((boundary) => ({
      testcaseId: `${boundary.boundaryId}-tc`,
      requirementId: boundary.requirementId || requirements[0]?.requirementId || "",
      unitId: boundary.unitId,
      name: `Boundary-value testcase for ${boundary.variable}`,
      designMethod: "boundary_value",
      inputs: { [boundary.variable]: boundary.candidates },
      oracleRef: `${boundary.boundaryId}-oracle`,
      expected: {},
      designReason: "Boundary-value testcase is mandatory for specification-driven verification.",
      sourceBasis: boundary.sourceRef,
      executionCategory: "spec-boundary-value",
      reviewStatus: boundary.reviewStatus,
      confidence: boundary.confidence,
      evidence: boundary.evidence,
      source: "specification"
    })),
    ...equivalencePartitions.map((partition) => ({
      testcaseId: `${partition.partitionId}-tc`,
      requirementId: partition.requirementId || requirements[0]?.requirementId || "",
      unitId: partition.unitId,
      name: `Equivalence-partition testcase for ${partition.variable}`,
      designMethod: "equivalence_partition",
      inputs: { representative: partition.representative, classes: partition.classes },
      oracleRef: `${partition.partitionId}-oracle`,
      expected: {},
      designReason: "Equivalence-partition testcase is mandatory for specification-driven verification.",
      sourceBasis: partition.sourceRef,
      executionCategory: "spec-equivalence-partition",
      reviewStatus: partition.reviewStatus,
      confidence: partition.confidence,
      evidence: partition.evidence,
      source: "specification"
    }))
  ];
  const specAnalysis = {
    schemaVersion: "unitverify.spec-analysis.v1",
    analysisId: `spec-derived-${Date.now()}`,
    sourceDocuments: [{ path: sourceName || "inline-specification", kind: "specification" }],
    requirements,
    units,
    assumptions: [],
    createdAt: now
  };
  const testDesign = {
    schemaVersion: "unitverify.test-design.v1",
    designId: `spec-derived-design-${Date.now()}`,
    language,
    source: { kind: "specification", path: sourceName || "inline-specification", origin: "specification" },
    testCases,
    manualTestCases,
    decisionTables,
    stateModels,
    boundaryValues,
    equivalencePartitions,
    undefinedBehaviorCorners: [],
    abnormalBehaviorCorners: [],
    testTechniqueSummary: [
      { technique: "manual", source: "specification", required: "always", status: "generated", applicationReason: "Manual testcase seeds are generated from each specification requirement." },
      { technique: "decision_table", source: "specification", required: "always_review_or_not_applicable", status: "generated", applicationReason: "Decision-table testing is generated from each requirement; rows without explicit conditions are marked needs_review." },
      { technique: "state_transition", source: "specification", required: "always_review_or_not_applicable", status: transitions.length ? "generated" : "not_applicable", applicationReason: transitions.length ? "Explicit state transitions were found." : "No explicit state transitions were found." },
      { technique: "boundary_value", source: "specification", required: "always", status: "generated", applicationReason: "Boundary-value testing is always generated; missing concrete boundaries are marked needs_review." },
      { technique: "equivalence_partition", source: "specification", required: "always", status: "generated", applicationReason: "Equivalence partitioning is always generated; missing concrete partitions are marked needs_review." }
    ],
    createdAt: now
  };
  const assertionArtifact = {
    schemaVersion: "unitverify.assertion.v1",
    assertionSetId: `spec-derived-assertions-${Date.now()}`,
    language,
    assertions: decisionTables.flatMap((table) => table.conditions.map((condition, index) => ({
      assertionId: `${condition.conditionId}-assertion`,
      requirementId: table.requirementId,
      unitId: table.unitId,
      kind: index === 0 ? "precondition" : "invariant",
      expression: condition.expression,
      location: condition.sourceRef,
      reviewStatus: condition.kind === "review-required" ? "needs_review" : "specified",
      confidence: condition.kind === "review-required" ? 0.25 : 0.7,
      evidence: condition.evidence,
      origin: "specification"
    })))
  };
  const oracleArtifact = {
    schemaVersion: "unitverify.oracle.v1",
    oracleSetId: `spec-derived-oracles-${Date.now()}`,
    language,
    oracles: testCases.map((tc) => ({
      oracleId: tc.oracleRef,
      requirementId: tc.requirementId,
      testcaseId: tc.testcaseId,
      unitId: tc.unitId,
      expectedReturn: undefined,
      expectedState: tc.expected?.nextState ? { nextState: tc.expected.nextState } : undefined,
      comparator: "custom",
      reviewStatus: tc.expected && Object.keys(tc.expected).length > 0 ? "specified" : "needs_review",
      confidence: tc.expected && Object.keys(tc.expected).length > 0 ? 0.65 : 0.2,
      evidence: tc.evidence,
      origin: "specification"
    }))
  };
  return { specAnalysis, testDesign, assertionArtifact, oracleArtifact };
}

async function generateDesignFromSpecTool(args) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const sourceName = args.specPath || "inline-specification";
  const specText = args.specText ?? (args.specPath ? await readFile(path.resolve(projectRoot, args.specPath), "utf8") : "");
  if (!String(specText || "").trim()) {
    return {
      status: "failed",
      artifacts: {},
      diagnostics: [{ severity: "error", code: "specification_missing", message: "specText or specPath must provide specification content.", source: "mcp", blocking: true }]
    };
  }
  const language = normalizeSourceLanguage(args.language || "unknown");
  const outDir = path.resolve(projectRoot, args.outDir || path.join(".perfectone", "unit-design", "spec-derived"));
  await mkdir(outDir, { recursive: true });
  const { specAnalysis, testDesign, assertionArtifact, oracleArtifact } = buildSpecDerivedArtifacts({
    projectRoot,
    specText,
    sourceName,
    language,
    targetUnits: Array.isArray(args.targetUnits) ? args.targetUnits : []
  });
  const specPath = path.join(outDir, "unitverify.spec-analysis.spec-derived.json");
  const testDesignPath = path.join(outDir, "unitverify.test-design.spec-derived.json");
  const assertionPath = path.join(outDir, "unitverify.assertion.spec-derived.json");
  const oraclePath = path.join(outDir, "unitverify.oracle.spec-derived.json");
  await writeFile(specPath, JSON.stringify(specAnalysis, null, 2), "utf8");
  await writeFile(testDesignPath, JSON.stringify(testDesign, null, 2), "utf8");
  await writeFile(assertionPath, JSON.stringify(assertionArtifact, null, 2), "utf8");
  await writeFile(oraclePath, JSON.stringify(oracleArtifact, null, 2), "utf8");
  const artifactEntries = [
    { artifact: specAnalysis, path: specPath },
    { artifact: testDesign, path: testDesignPath },
    { artifact: assertionArtifact, path: assertionPath },
    { artifact: oracleArtifact, path: oraclePath }
  ];
  const validations = artifactEntries.map((entry) => ({ path: entry.path, ...validateUnitDesignArtifact(entry.artifact) }));
  const reviewHtmlPath = path.join(outDir, "spec-derived-review.html");
  const markdownPath = path.join(outDir, "unit-design-from-spec.md");
  await writeFile(reviewHtmlPath, renderUnitDesignReviewHtml({ title: "Specification-derived Unit Design Review", artifacts: artifactEntries, validations }), "utf8");
  await writeFile(markdownPath, renderUnitDesignMarkdownFromTemplate({
    projectRoot,
    sourceFiles: [path.resolve(projectRoot, sourceName)],
    units: specAnalysis.units,
    specAnalysis,
    testDesign,
    origin: "specification"
  }), "utf8");
  const failedValidation = validations.some((item) => !item.valid);
  return {
    status: failedValidation ? "failed" : "passed",
    artifacts: {
      specAnalysis: specPath,
      testDesign: testDesignPath,
      assertions: assertionPath,
      oracles: oraclePath,
      reviewHtml: reviewHtmlPath,
      unitDesignMarkdown: markdownPath
    },
    validations,
    reviewStatusSummary: summarizeReviewStatusFromArtifacts([specAnalysis, testDesign, assertionArtifact, oracleArtifact]),
    techniqueSummary: testDesign.testTechniqueSummary,
    diagnostics: []
  };
}

async function extractDesignFromSourceTool(args) {
  const projectRoot = path.resolve(args.projectRoot || workspaceRoot);
  const sourceInputs = Array.isArray(args.sourceFiles) ? args.sourceFiles : [];
  const diagnostics = [];
  if (sourceInputs.length === 0) {
    return {
      status: "failed",
      sourceFacts: { units: [], branches: [], stateCandidates: [], inputOutputCandidates: [] },
      artifacts: {},
      reviewStatusSummary: {},
      diagnostics: [{
        severity: "error",
        code: "source_files_missing",
        message: "sourceFiles must contain at least one source file.",
        source: "mcp",
        blocking: true
      }]
    };
  }
  const sourceFiles = sourceInputs.map((item) => path.isAbsolute(item) ? path.resolve(item) : path.resolve(projectRoot, item));
  const symbols = Array.isArray(args.symbols) ? args.symbols : [];
  const allUnits = [];
  for (const sourcePath of sourceFiles) {
    const relativeFile = path.relative(projectRoot, sourcePath) || path.basename(sourcePath);
    const text = await readTextIfExists(sourcePath);
    if (!text) {
      diagnostics.push({
        severity: "warning",
        code: "source_file_unreadable",
        message: `Source file was not readable or empty: ${sourcePath}`,
        source: "mcp"
      });
      continue;
    }
    const language = normalizeSourceLanguage(args.language, sourcePath);
    let extracted = null;
    if (language === "cpp" && args.preferCompilerAst !== false) {
      extracted = extractClangAstUnits({
        sourcePath,
        relativeFile,
        text,
        language,
        symbols,
        compileArgs: Array.isArray(args.compileArgs) ? args.compileArgs : []
      });
      diagnostics.push(...(extracted.diagnostics || []));
      if (!extracted.used) extracted = null;
    } else if (language === "c") {
      diagnostics.push({
        severity: "info",
        code: "c_source_design_backend_perfectone",
        message: "C source-to-design keeps PerfectOne as the authority. The MCP lightweight extractor is used only for draft review artifacts when PerfectOne IR is not supplied to this tool.",
        source: "mcp"
      });
    } else if (["python", "go", "java", "ruby", "js", "ts"].includes(language) && args.preferCompilerAst !== false) {
      extracted = runExternalAstAdapter({ sourcePath, relativeFile, text, language, symbols });
      diagnostics.push(...(extracted.diagnostics || []));
      if (!extracted.used) extracted = null;
    } else if (["rust", "csharp"].includes(language)) {
      diagnostics.push({
        severity: "info",
        code: `${language}_ast_adapter_not_installed`,
        message: `${language} AST adapter requires an additional helper dependency; using lightweight extraction for this run.`,
        source: "mcp"
      });
    }
    if (!extracted) {
      extracted = extractSourceUnits({ sourcePath, relativeFile, text, language, symbols });
      extracted.units = extracted.units.map((unit) => ({ ...unit, extractionBackend: "lightweight-source-text" }));
    }
    allUnits.push(...extracted.units);
    diagnostics.push(...extracted.diagnostics);
  }
  if (args.includeBranches === false) {
    for (const unit of allUnits) unit.branches = [];
  }
  const branches = allUnits.flatMap((unit) => unit.branches);
  const stateCandidates = allUnits.flatMap((unit) => unit.stateCandidates);
  const inputOutputCandidates = allUnits.flatMap((unit) => [
    ...unit.parameters.map((param) => ({
      unitId: unit.unitId,
      name: param.name,
      type: param.type,
      role: param.role,
      sourceRef: unit.sourceRef,
      evidence: `${param.role} candidate from ${unit.symbol} signature at ${unit.sourceRef}: ${param.raw}`,
      reviewStatus: "inferred"
    })),
    ...(unit.returnType && !["void", "()"].includes(unit.returnType) ? [{
      unitId: unit.unitId,
      name: "return",
      type: unit.returnType,
      role: "return",
      sourceRef: unit.sourceRef,
      evidence: `Return candidate from ${unit.symbol} signature at ${unit.sourceRef}: ${unit.returnType}`,
      reviewStatus: "inferred"
    }] : [])
  ]);
  const language = normalizeSourceLanguage(args.language, sourceFiles[0]);
  const outDir = path.resolve(projectRoot, args.outDir || path.join(".perfectone", "unit-design", "source-derived"));
  await mkdir(outDir, { recursive: true });
  const { specAnalysis, testDesign, assertionArtifact, oracleArtifact } = buildSourceDerivedArtifacts({
    projectRoot,
    units: allUnits,
    branches,
    stateCandidates,
    inputOutputCandidates,
    language,
    sourceFiles,
    includeAssertions: args.includeAssertions !== false,
    includeOracles: args.includeOracles !== false
  });
  const specPath = path.join(outDir, "unitverify.spec-analysis.source-derived.json");
  const testDesignPath = path.join(outDir, "unitverify.test-design.source-derived.json");
  const assertionPath = path.join(outDir, "unitverify.assertion.source-derived.json");
  const oraclePath = path.join(outDir, "unitverify.oracle.source-derived.json");
  const markdownPath = path.join(outDir, "unit-design-from-source.md");
  await writeFile(specPath, JSON.stringify(specAnalysis, null, 2), "utf8");
  await writeFile(testDesignPath, JSON.stringify(testDesign, null, 2), "utf8");
  await writeFile(assertionPath, JSON.stringify(assertionArtifact, null, 2), "utf8");
  await writeFile(oraclePath, JSON.stringify(oracleArtifact, null, 2), "utf8");
  await writeFile(markdownPath, renderUnitDesignMarkdownFromTemplate({
    projectRoot,
    sourceFiles,
    units: allUnits,
    specAnalysis,
    testDesign,
    origin: "source-derived"
  }), "utf8");
  const artifactEntries = [
    { artifact: specAnalysis, path: specPath },
    { artifact: testDesign, path: testDesignPath },
    { artifact: assertionArtifact, path: assertionPath },
    { artifact: oracleArtifact, path: oraclePath }
  ];
  const validations = artifactEntries.map((entry) => ({ path: entry.path, ...validateUnitDesignArtifact(entry.artifact) }));
  const reviewHtmlPath = path.join(outDir, "source-derived-review.html");
  await writeFile(reviewHtmlPath, renderUnitDesignReviewHtml({ title: "Source-derived Unit Design Review", artifacts: artifactEntries, validations }), "utf8");
  if (allUnits.length === 0) {
    diagnostics.push({
      severity: "error",
      code: "source_units_not_found",
      message: "No function or method definitions were detected in the provided source files.",
      source: "mcp",
      blocking: true
    });
  }
  const sourceFacts = {
    units: allUnits.map(({ branches: _branches, returns: _returns, stateCandidates: _stateCandidates, ...unit }) => unit),
    branches,
    stateCandidates,
    inputOutputCandidates
  };
  const reviewStatusSummary = summarizeReviewStatusFromArtifacts([specAnalysis, testDesign, assertionArtifact, oracleArtifact]);
  const failedValidation = validations.some((item) => !item.valid);
  const hasNonInfoDiagnostics = diagnostics.some((item) => item.severity !== "info");
  return {
    status: allUnits.length === 0 || failedValidation ? "failed" : hasNonInfoDiagnostics ? "partial" : "passed",
    sourceFacts,
    artifacts: {
      specAnalysis: specPath,
      testDesign: testDesignPath,
      assertions: assertionPath,
      oracles: oraclePath,
      reviewHtml: reviewHtmlPath,
      unitDesignMarkdown: markdownPath
    },
    validations,
    reviewStatusSummary,
    diagnostics
  };
}

async function loadUnitVerifyLog(report, outDir) {
  const candidates = [];
  for (const artifact of report?.artifacts || []) {
    const filePath = artifactPath(artifact);
    if (filePath && /perfectone_unit_verify\.log$/i.test(filePath)) candidates.push(filePath);
  }
  candidates.push(path.join(outDir, "perfectone_unit_verify.log"));
  for (const candidate of candidates) {
    const text = await readTextIfExists(candidate);
    if (text) return text;
  }
  return "";
}

async function normalizeUnitVerifyResult({ cliPath, request, projectRoot, tempDir, reportPath, result, injectedCompileContext, targetFunctionFilter }) {
  let report = null;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    report = parseJsonOutput(result);
  }
  if (!report || typeof report !== "object") {
    report = {
      schemaVersion: "perfectone.unitverify.report.v1",
      runId: "unknown",
      status: "failed",
      coverage: { line: null, branch: null, mcdc: null },
      functions: [],
      artifacts: [],
      diagnostics: [{ severity: "error", code: "invalid_cli_report", message: "CLI did not produce a parseable report." }],
      recommendedActions: []
    };
  }
  report.artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
  report.diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  report.recommendedActions = Array.isArray(report.recommendedActions) ? report.recommendedActions : [];

  const outDir = resolveRequestOutDir(projectRoot, request);
  const cFlowEnabled = isCRequest(request);
  if (cFlowEnabled) {
    const generatedIrPath = path.join(outDir, "ir.json");
    if (pathExists(generatedIrPath)) {
      const irTargetFunctionFilter = await buildSourceTargetFilter(projectRoot, request, { irPath: generatedIrPath });
      if (irTargetFunctionFilter.generated) {
        targetFunctionFilter = irTargetFunctionFilter;
      }
    }
  }
  const environment = normalizeEnvironment(request.environment || {});
  const localToolchain = detectLocalToolchain({ ...environment, language: request.language || "c" });
  const logText = await loadUnitVerifyLog(report, outDir);
  const diagnostics = normalizeDiagnostics({
    report,
    stderr: result.stderr,
    stdout: result.stdout,
    logText,
    localToolchain
  });
  for (const diagnostic of injectedCompileContext?.diagnostics || []) {
    pushDiagnostic(diagnostics, diagnostic);
  }
  const functionReports = buildFunctionReports(report, request, diagnostics);
  const compileHints = compileContextHints(projectRoot, diagnostics);
  const actions = codingPlatformActions(report, diagnostics, localToolchain, compileHints, { cFlowEnabled });
  const platformPrompt = codingPlatformPrompt({ request, diagnostics, functionReports, compileHints, actions, cFlowEnabled });
  const unitDesignValidation = await validateUnitDesignRefs(projectRoot, request.unitDesignArtifacts);
  if (unitDesignValidation.error) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "unit_design_artifact_load_failed",
      message: unitDesignValidation.error,
      source: "mcp"
    });
  } else if ((unitDesignValidation.validations || []).some((item) => !item.valid)) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "unit_design_artifact_validation_failed",
      message: "One or more language-independent unit design artifacts did not pass MCP validation.",
      source: "mcp"
    });
  }
  report.diagnostics = diagnostics;
  report.functionReports = functionReports;
  report.localToolchain = localToolchain;
  report.toolchainEnvironment = detectToolchainEnvironment({
    projectRoot,
    language: request.language || "c",
    sourceFiles: request.sourceFiles || [],
    environment
  });
  report.unitDesignArtifacts = request.unitDesignArtifacts || report.unitDesignArtifacts || null;
  report.unitDesignArtifactValidation = unitDesignValidation;
  report.mcpInjectedCompileContext = injectedCompileContext || { generated: false };
  if (cFlowEnabled) {
    report.mcpTargetFunctionFilter = targetFunctionFilter || { generated: false };
    report.mcpStatus = report.status === "coverage_unmet" ? "needs_c_coverage_execution" : report.status;
    report.cUnitVerificationFlow = buildCUnitVerificationFlow({
      report,
      targetFunctionFilter: report.mcpTargetFunctionFilter,
      functionReports,
      result
    });
  } else {
    report.mcpStatus = report.status;
  }
  report.compileContextHints = compileHints;
  report.codingPlatformActions = actions;
  report.codingPlatformPrompt = platformPrompt;
  report.recommendedActions = mergeActions(report.recommendedActions, actions);
  report.failureEvidence = collectFailureEvidence({ projectRoot, outDir, cliPath });
  if (report.cUnitVerificationFlow) {
    report.cUnitVerificationFlow.failureEvidenceSummary = report.failureEvidence.summary;
  }

  const diagnosticSummary = summarizeDiagnostics(diagnostics);
  report.diagnosticSummary = diagnosticSummary;
  report.tokenUsage = buildPluginTokenUsage({
    inputPayloads: [
      { name: "unitVerifyRequest", value: request, surface: "mcp" },
      { name: "compileContext", value: injectedCompileContext, surface: "mcp" },
      { name: "sourceTargetFilter", value: targetFunctionFilter, surface: "mcp" }
    ],
    outputPayloads: [
      { name: "cliStdout", value: result.stdout, surface: "cli" },
      { name: "cliStderr", value: result.stderr, surface: "cli" },
      { name: "unitVerifyLogExcerpt", value: logText, surface: "cli" },
      { name: "normalizedReport", value: reportWithoutTokenUsage(report), surface: "report" }
    ]
  });
  const generatedReports = await writeReportBundle(outDir, report, diagnosticSummary);
  report.artifacts = [...report.artifacts, ...generatedReports];

  return {
    status: report.status || (result.code === 0 ? "passed" : "failed"),
    mcpStatus: report.mcpStatus,
    cliPath,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    requestPath: path.join(tempDir, "request.json"),
    reportPath,
    outDir,
    report,
    stderr: truncate(result.stderr),
    stdout: truncate(result.stdout),
    logExcerpt: truncate(logText),
    diagnosticSummary,
    blockingDiagnostics: diagnostics.filter((item) => item.blocking),
    recommendedActions: report.recommendedActions,
    codingPlatformPrompt: platformPrompt,
    compileContextHints: compileHints,
    mcpInjectedCompileContext: report.mcpInjectedCompileContext,
    mcpTargetFunctionFilter: report.mcpTargetFunctionFilter,
    cUnitVerificationFlow: report.cUnitVerificationFlow,
    failureEvidence: report.failureEvidence,
    tokenUsage: report.tokenUsage
  };
}

function parseOptionalIntegerOption(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeCoverageTuningOptions(coverageOptions, diagnostics) {
  const raw = coverageOptions && typeof coverageOptions === "object" ? coverageOptions : {};
  const tuning = {
    source: "coding-agent-supplied",
    mcpRecommendation: false,
    noImplicitPerfectOneDefaults: true,
    heterogeneous: null,
    structDepth: null,
    pointerArraySize: null,
    arrayMaxDims: null,
    famSize: null,
    executionProfile: "quick",
    kleeMaxTime: C_COVERAGE_PROFILE_DEFAULTS.quick.kleeMaxTime,
    kleeMaxMemory: C_COVERAGE_PROFILE_DEFAULTS.quick.kleeMaxMemory,
    replayMaxCasesPerFunction: C_COVERAGE_PROFILE_DEFAULTS.quick.replayMaxCasesPerFunction,
    replayDedup: C_COVERAGE_PROFILE_DEFAULTS.quick.replayDedup,
    nativeReplayTimeout: C_COVERAGE_PROFILE_DEFAULTS.quick.nativeReplayTimeout,
    ignored: []
  };
  const requestedProfile = String(raw.executionProfile ?? raw.execution_profile ?? "quick").toLowerCase();
  tuning.executionProfile = Object.prototype.hasOwnProperty.call(C_COVERAGE_PROFILE_DEFAULTS, requestedProfile)
    ? requestedProfile
    : "quick";
  if (requestedProfile && requestedProfile !== tuning.executionProfile) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "invalid_execution_profile",
      message: `coverageOptions.executionProfile was ignored because ${JSON.stringify(requestedProfile)} is not quick, full, or setup.`,
      source: "mcp"
    });
  }
  const profileDefaults = C_COVERAGE_PROFILE_DEFAULTS[tuning.executionProfile];
  tuning.kleeMaxTime = profileDefaults.kleeMaxTime;
  tuning.kleeMaxMemory = profileDefaults.kleeMaxMemory;
  tuning.replayMaxCasesPerFunction = profileDefaults.replayMaxCasesPerFunction;
  tuning.replayDedup = profileDefaults.replayDedup;
  tuning.nativeReplayTimeout = profileDefaults.nativeReplayTimeout;

  if ("wslPathMode" in raw || "wsl-path-mode" in raw || "wsl_path_mode" in raw) {
    const requestedWslPathMode = String(raw.wslPathMode ?? raw["wsl-path-mode"] ?? raw.wsl_path_mode).toLowerCase();
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "wsl_path_mode_disabled",
      message: `coverageOptions.wslPathMode=${JSON.stringify(requestedWslPathMode)} was ignored because WSL execution is disabled for this plugin path.`,
      source: "mcp"
    });
  }

  for (const [publicName, dashName, snakeName] of [
    ["kleeMaxTime", "klee-max-time", "klee_max_time"],
    ["kleeMaxMemory", "klee-max-memory", "klee_max_memory"],
    ["replayMaxCasesPerFunction", "replay-max-cases-per-function", "replay_max_cases_per_function"],
    ["nativeReplayTimeout", "native-replay-timeout", "native_replay_timeout"]
  ]) {
    const value = parseOptionalIntegerOption(raw[publicName] ?? raw[dashName] ?? raw[snakeName]);
    if (value !== null) tuning[publicName] = value;
    else if (publicName in raw || dashName in raw || snakeName in raw) {
      pushDiagnostic(diagnostics, {
        severity: "warning",
        code: `invalid_${snakeName}`,
        message: `coverageOptions.${publicName} was ignored because it is not a non-negative integer.`,
        source: "mcp"
      });
    }
  }

  const requestedReplayDedup = String(raw.replayDedup ?? raw["replay-dedup"] ?? raw.replay_dedup ?? tuning.replayDedup).toLowerCase();
  if (["coverage-signature", "input-hash", "none"].includes(requestedReplayDedup)) {
    tuning.replayDedup = requestedReplayDedup;
  } else if (requestedReplayDedup) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "invalid_replay_dedup",
      message: `coverageOptions.replayDedup was ignored because ${JSON.stringify(requestedReplayDedup)} is not coverage-signature, input-hash, or none.`,
      source: "mcp"
    });
  }

  if ("pointerDepth" in raw || "pointer-depth" in raw || "pointer_depth" in raw) {
    tuning.ignored.push({
      option: "pointerDepth",
      reason: "PerfectOne CLI accepts --pointer-depth only as deprecated and ignored; MCP does not pass it."
    });
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "pointer_depth_ignored",
      message: "coverageOptions.pointerDepth was ignored because PerfectOne CLI treats --pointer-depth as deprecated and ignored.",
      source: "mcp"
    });
  }

  const heteroValue = raw.heterogeneous ?? raw.hetero;
  if (typeof heteroValue === "boolean") tuning.heterogeneous = heteroValue;
  else if (typeof heteroValue === "string") {
    if (/^(true|on|enable|enabled|1)$/i.test(heteroValue)) tuning.heterogeneous = true;
    else if (/^(false|off|disable|disabled|0)$/i.test(heteroValue)) tuning.heterogeneous = false;
  }

  const requestedStructDepth = parseOptionalIntegerOption(raw.structDepth ?? raw["struct-depth"] ?? raw.struct_depth);
  if (requestedStructDepth !== null) {
    const clamped = Math.min(requestedStructDepth, C_STRUCT_DEPTH_SECURITY_MAX);
    tuning.structDepth = {
      requested: requestedStructDepth,
      value: clamped,
      clamped: clamped !== requestedStructDepth,
      max: C_STRUCT_DEPTH_SECURITY_MAX
    };
    if (tuning.structDepth.clamped) {
      pushDiagnostic(diagnostics, {
        severity: "warning",
        code: "struct_depth_clamped",
        message: `coverageOptions.structDepth ${requestedStructDepth} exceeded the security maximum ${C_STRUCT_DEPTH_SECURITY_MAX}; using ${clamped}.`,
        source: "mcp"
      });
    }
  } else if ("structDepth" in raw || "struct-depth" in raw || "struct_depth" in raw) {
    pushDiagnostic(diagnostics, {
      severity: "warning",
      code: "invalid_struct_depth",
      message: "coverageOptions.structDepth was ignored because it is not a non-negative integer.",
      source: "mcp"
    });
  }

  for (const item of [
    ["pointerArraySize", "pointer-array-size", "pointer_array_size"],
    ["arrayMaxDims", "array-max-dims", "array_max_dims"],
    ["famSize", "fam-size", "fam_size"]
  ]) {
    const [publicName, dashName, snakeName] = item;
    const value = parseOptionalIntegerOption(raw[publicName] ?? raw[dashName] ?? raw[snakeName]);
    if (value !== null) tuning[publicName] = value;
    else if (publicName in raw || dashName in raw || snakeName in raw) {
      pushDiagnostic(diagnostics, {
        severity: "warning",
        code: `invalid_${snakeName}`,
        message: `coverageOptions.${publicName} was ignored because it is not a non-negative integer.`,
        source: "mcp"
      });
    }
  }

  return tuning;
}

function applyCoverageTuningArgs(cliArgs, coverageTuning) {
  if (!coverageTuning) return cliArgs;
  if (coverageTuning.heterogeneous === true) cliArgs.push("--enable-heterogeneous");
  if (coverageTuning.heterogeneous === false) cliArgs.push("--disable-heterogeneous");
  if (coverageTuning.structDepth?.value !== null && coverageTuning.structDepth?.value !== undefined) {
    cliArgs.push("--struct-depth", String(coverageTuning.structDepth.value));
  }
  if (coverageTuning.pointerArraySize !== null && coverageTuning.pointerArraySize !== undefined) {
    cliArgs.push("--pointer-array-size", String(coverageTuning.pointerArraySize));
  }
  if (coverageTuning.arrayMaxDims !== null && coverageTuning.arrayMaxDims !== undefined) {
    cliArgs.push("--array-max-dims", String(coverageTuning.arrayMaxDims));
  }
  if (coverageTuning.famSize !== null && coverageTuning.famSize !== undefined) {
    cliArgs.push("--fam-size", String(coverageTuning.famSize));
  }
  return cliArgs;
}

function applyCoverageRuntimeArgs(cliArgs, coverageTuning) {
  if (!coverageTuning) return cliArgs;
  cliArgs.push("--execution-profile", coverageTuning.executionProfile || "quick");
  cliArgs.push("--replay-max-cases-per-function", String(coverageTuning.replayMaxCasesPerFunction ?? 128));
  cliArgs.push("--replay-dedup", coverageTuning.replayDedup || "input-hash");
  cliArgs.push("--native-replay-timeout", String(coverageTuning.nativeReplayTimeout ?? 5));
  return cliArgs;
}

function isDockerLlvm18Tool(value, toolName) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text) return false;
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|/)${escaped}(\\.exe)?$`, "i").test(text);
}

function resolveDockerCoverageTools(coverageOptions, diagnostics) {
  const tools = { ...DOCKER_LLVM18_COVERAGE_TOOLS };
  for (const [optionName, toolName] of [
    ["clang", "clang-18"],
    ["llvmCov", "llvm-cov-18"],
    ["llvmProfdata", "llvm-profdata-18"]
  ]) {
    const requested = coverageOptions?.[optionName];
    if (requested === null || requested === undefined || requested === "") continue;
    if (isDockerLlvm18Tool(requested, toolName)) {
      tools[optionName] = String(requested);
      continue;
    }
    const rawName = optionName === "llvmCov" ? "llvm-cov" : optionName === "llvmProfdata" ? "llvm-profdata" : optionName;
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "docker_mcdc_requires_llvm18_tool",
      message: `Docker MC/DC coverage requires ${toolName}; coverageOptions.${optionName}=${JSON.stringify(requested)} would select ${rawName} without LLVM 18 MC/DC guarantees. Omit this option or set ${DOCKER_LLVM18_COVERAGE_TOOLS[optionName]}.`,
      source: "mcp",
      blocking: true
    });
  }
  return tools;
}

function dockerCoverageArgs({ irPath, outDir, sourceFile, regex, coverageOptions, coverageTuning, dockerToolchain }) {
  const effectiveCoverageOptions = coverageOptions || {};
  const cliArgs = [
    "--phase", "docker",
    "--runner", "docker",
    "--ir", irPath,
    "--outdir", outDir,
    "--func_regex", regex,
    "--prefer-xml-testcases=true",
    "--coverage-engine", "llvm",
    "--mcdc",
    "--branch"
  ];
  if (sourceFile) cliArgs.push("--input", sourceFile);
  const defaults = {
    kleeMaxTime: coverageTuning?.kleeMaxTime ?? effectiveCoverageOptions.kleeMaxTime ?? 60,
    kleeMaxMemory: coverageTuning?.kleeMaxMemory ?? effectiveCoverageOptions.kleeMaxMemory ?? 4096,
    clang: dockerToolchain?.clang || DOCKER_LLVM18_COVERAGE_TOOLS.clang,
    llvmCov: dockerToolchain?.llvmCov || DOCKER_LLVM18_COVERAGE_TOOLS.llvmCov,
    llvmProfdata: dockerToolchain?.llvmProfdata || DOCKER_LLVM18_COVERAGE_TOOLS.llvmProfdata,
    llvm2lcov: effectiveCoverageOptions.llvm2lcov || "/usr/local/bin/llvm2lcov",
    lcov: effectiveCoverageOptions.lcov || "/usr/local/bin/lcov",
    genhtml: effectiveCoverageOptions.genhtml || "/usr/local/bin/genhtml"
  };
  cliArgs.push("--klee-max-time", String(defaults.kleeMaxTime));
  cliArgs.push("--klee-max-memory", String(defaults.kleeMaxMemory));
  applyCoverageRuntimeArgs(cliArgs, coverageTuning);
  if (Number.isFinite(Number(effectiveCoverageOptions.kleeParallel))) {
    cliArgs.push("--klee-parallel", String(Number(effectiveCoverageOptions.kleeParallel)));
  }
  if (Number.isFinite(Number(effectiveCoverageOptions.kleeTestParallel))) {
    cliArgs.push("--klee-test-parallel", String(Number(effectiveCoverageOptions.kleeTestParallel)));
  }
  cliArgs.push("--clang", defaults.clang);
  cliArgs.push("--llvm-cov", defaults.llvmCov);
  cliArgs.push("--llvm-profdata", defaults.llvmProfdata);
  cliArgs.push("--llvm2lcov", defaults.llvm2lcov);
  cliArgs.push("--lcov", defaults.lcov);
  cliArgs.push("--genhtml", defaults.genhtml);
  applyCoverageTuningArgs(cliArgs, coverageTuning);
  return cliArgs;
}

function nativeCoverageArgs({ irPath, outDir, sourceFile, regex, coverageOptions = {}, coverageTuning, runner = "local", environment = {} }) {
  const effectiveCoverageOptions = coverageOptions || {};
  const defaults = {
    kleeMaxTime: coverageTuning?.kleeMaxTime ?? effectiveCoverageOptions.kleeMaxTime ?? 60,
    kleeMaxMemory: coverageTuning?.kleeMaxMemory ?? effectiveCoverageOptions.kleeMaxMemory ?? 4096
  };
  const cliArgs = [
    "--phase", "c-coverage",
    "--runner", runner,
    "--ir", irPath,
    "--outdir", outDir,
    "--func_regex", regex,
    "--prefer-xml-testcases=true",
    "--coverage-engine", "llvm",
    "--mcdc",
    "--branch",
    "--klee-max-time", String(defaults.kleeMaxTime),
    "--klee-max-memory", String(defaults.kleeMaxMemory)
  ];
  applyCoverageRuntimeArgs(cliArgs, coverageTuning);
  if (Number.isFinite(Number(effectiveCoverageOptions.kleeParallel))) {
    cliArgs.push("--klee-parallel", String(Number(effectiveCoverageOptions.kleeParallel)));
  }
  if (Number.isFinite(Number(effectiveCoverageOptions.kleeTestParallel))) {
    cliArgs.push("--klee-test-parallel", String(Number(effectiveCoverageOptions.kleeTestParallel)));
  }
  if (sourceFile) cliArgs.push("--input", sourceFile);
  applyCoverageTuningArgs(cliArgs, coverageTuning);
  return cliArgs;
}

function wslDirectCoverageArgs({ irPath, outDir, sourceFile, regex, coverageOptions = {}, coverageTuning }) {
  return nativeCoverageArgs({
    irPath: toWslPath(irPath),
    outDir: toWslPath(outDir),
    sourceFile: sourceFile ? toWslPath(sourceFile) : sourceFile,
    regex,
    coverageOptions,
    coverageTuning,
    runner: "local",
    environment: { hostOs: "linux", targetOs: "linux" }
  });
}

function localReplayCoverageArgs({ irPath, outDir, sourceFile, regex, coverageOptions, coverageTuning }) {
  return nativeCoverageArgs({ irPath, outDir, sourceFile, regex, coverageOptions, coverageTuning });
}

function parseDockerDiscoveredCount(stdout, stderr) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const match = text.match(/docker phase:\s*found\s+(\d+)\s+functions/i);
  return match ? Number(match[1]) : null;
}

function clangSupportsMcdc(toolchain) {
  const clang = (toolchain.tools || []).find((item) => item.name === "clang" && item.available);
  if (!clang) return false;
  const version = String(clang.version || "");
  const match = version.match(/(?:clang|LLVM).*?(\d+)\./i);
  return match ? Number(match[1]) >= 18 : true;
}

function nativeCoverageReady(toolchain) {
  const has = (name) => (toolchain.tools || []).some((item) => item.name === name && item.available);
  return has("klee") && has("clang") && has("llvm-cov") && has("llvm-profdata") && clangSupportsMcdc(toolchain);
}

function cPreviewUnsupported(language, details = {}) {
  return {
    status: "unsupported",
    code: "non_c_temporarily_disabled",
    message: "This plugin deployment currently enables C coverage/assertion workflows only.",
    language: language || "unknown",
    ...details
  };
}

function coverageJobPaths(outDir, jobId) {
  const root = path.join(outDir, ".perfectone", "coverage_jobs", jobId);
  return {
    root,
    statusPath: path.join(root, "status.json"),
    progressPath: path.join(root, "progress.json"),
    stdoutPath: path.join(root, "stdout.log"),
    stderrPath: path.join(root, "stderr.log"),
    commandPath: path.join(root, "command.json")
  };
}

async function writeJson(pathName, value) {
  await mkdir(path.dirname(pathName), { recursive: true });
  await writeFile(pathName, JSON.stringify(value, null, 2), "utf8");
}

function readJsonWithFallbackSync(pathName, fallback = null) {
  try {
    if (!pathName || !existsSync(pathName)) return fallback;
    const text = readFileSync(pathName, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readFirstStatusCode(statusPath) {
  try {
    const text = readFileSync(statusPath, "utf8");
    const match = text.match(/exitCode\s*=\s*(-?\d+)/i) || text.match(/^\s*(-?\d+)\s*$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function countFilesRecursive(root, predicate) {
  let count = 0;
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!predicate || predicate(full, entry.name)) count += 1;
    }
  };
  walk(root);
  return count;
}

function summarizeCoverageProgress(outDir, targetFunctionFilter = null) {
  const functions = Array.isArray(targetFunctionFilter?.functions) ? targetFunctionFilter.functions : [];
  const functionSet = new Set(functions);
  let functionDirs = [];
  try {
    functionDirs = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && (functionSet.size === 0 || functionSet.has(entry.name)))
      .map((entry) => entry.name);
  } catch {
    functionDirs = [];
  }
  const totalFunctions = functions.length || functionDirs.length || null;
  let kleeCompleted = 0;
  let kleePartial = 0;
  let nativeReplayCompleted = 0;
  let nativeReplayCrash = 0;
  let nativeReplayTimeout = 0;
  let kleeTimedOut = 0;
  let profrawCount = 0;
  let currentFunction = null;
  let latestMtime = 0;
  const partialManifest = readJsonWithFallbackSync(path.join(outDir, "coverage_partial_manifest.json"), null);
  for (const functionName of functionDirs) {
    const functionDir = path.join(outDir, functionName);
    const kleeStatus = readFirstStatusCode(path.join(functionDir, ".perfectone", "docker_logs", "klee_run.status"));
    const generatedTests = countFilesRecursive(path.join(functionDir, "klee-out"), (_full, name) => /\.(ktest|xml)$/i.test(name));
    if (kleeStatus === 0) kleeCompleted += 1;
    else if (generatedTests > 0) kleePartial += 1;
    else if (kleeStatus === 124 || kleeStatus === 137) kleeTimedOut += 1;
    profrawCount += countFilesRecursive(functionDir, (_full, name) => /\.profraw$/i.test(name));
    const tempRootEntries = (() => {
      try {
        return readdirSync(functionDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^temp_(run|cbmc)_/i.test(entry.name));
      } catch {
        return [];
      }
    })();
    for (const entry of tempRootEntries) {
      const tempDir = path.join(functionDir, entry.name);
      const status = readFirstStatusCode(path.join(tempDir, "native_run.status"));
      if (status === 0) nativeReplayCompleted += 1;
      else if (status === 124) nativeReplayTimeout += 1;
      else if (status === 139 || status === 134 || status === 136) nativeReplayCrash += 1;
      try {
        const mtime = statSync(tempDir).mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          currentFunction = functionName;
        }
      } catch {
        // ignore progress stat failures
      }
    }
  }
  const runnerName = String(partialManifest?.runner || partialManifest?.execution_mode || "docker");
  const aggregateLogCandidates = [
    path.join(outDir, ".perfectone", "runner_logs", runnerName, "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "docker", "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "local", "coverage_aggregate.log"),
    path.join(outDir, ".perfectone", "runner_logs", "wsl", "coverage_aggregate.log")
  ];
  const aggregateLog = aggregateLogCandidates.find((candidate) => pathExists(candidate)) || aggregateLogCandidates[0];
  return {
    phase: pathExists(path.join(outDir, "coverage_input_file.info"))
      ? "completed"
      : (pathExists(aggregateLog) ? "aggregate" : (nativeReplayCompleted + nativeReplayCrash + nativeReplayTimeout > 0 ? "native_replay" : (kleeCompleted + kleePartial > 0 ? "klee" : "starting"))),
    currentFunction,
    completedFunctions: pathExists(path.join(outDir, "coverage_results"))
      ? countFilesRecursive(path.join(outDir, "coverage_results"), (_full, name) => /^coverage_.*\.info$/i.test(name))
      : 0,
    totalFunctions,
    kleeCompleted,
    kleePartial,
    kleeTimedOut,
    nativeReplayCompleted,
    nativeReplayCrash,
    nativeReplayTimeout,
    profrawCount,
    mergeCompleted: pathExists(path.join(outDir, "coverage_input_file.info")),
    coverageCliStage: partialManifest?.stage || null,
    coverageCliMessage: partialManifest?.message || null,
    kleeWallTimeoutSec: partialManifest?.klee_wall_timeout_sec ?? null,
    pipelineOverlap: partialManifest?.pipeline_overlap || null,
    recentLog: pathExists(aggregateLog) ? aggregateLog : null,
    lastUpdatedAt: new Date().toISOString(),
    nextPollAfterMs: COVERAGE_JOB_POLL_MS
  };
}

function coverageInvocationForJob({ cliPath, args, outDir, irPath, sourceFile, targetFunctionFilter, selection, localToolchain, coverageOptions, coverageTuning, dockerToolchain, environment, wslDirectRequested, wslDirectDisabled }) {
  const executionMode = selection.executionMode;
  const runner = selection.runner;
  let cliArgs = [];
  let command = null;
  let spawnCommand = cliPath;
  let spawnArgs = [];
  let cwd = projectRootFromArgs(args);
  let cliInvocation = {
    mode: "host",
    hostCliPath: cliPath || null,
    wslCli: null,
    directWslCliUsed: false,
    fallbackReason: null
  };
  if (runner === "noop") {
    return { cliArgs: [], command: ["noop"], spawnCommand: null, spawnArgs: [], cwd, cliInvocation };
  }
  if (runner === "none" || executionMode === "none" || executionMode === "unsupported") {
    return { cliArgs: [], command: [], spawnCommand: null, spawnArgs: [], cwd, cliInvocation };
  }
  if (executionMode === "docker") {
    cliArgs = dockerCoverageArgs({ irPath, outDir, sourceFile, regex: targetFunctionFilter.regex, coverageOptions, coverageTuning, dockerToolchain });
    spawnArgs = cliArgs;
    cwd = path.dirname(cliPath);
  } else {
    cliArgs = nativeCoverageArgs({ irPath, outDir, sourceFile, regex: targetFunctionFilter.regex, coverageOptions, coverageTuning, runner, environment });
    spawnArgs = cliArgs;
    cwd = executionMode === "docker" ? path.dirname(cliPath) : projectRootFromArgs(args);
    cliInvocation = {
      ...cliInvocation,
      mode: "host",
      fallbackReason: null
    };
  }
  command = [spawnCommand, ...spawnArgs];
  return { cliArgs, command, spawnCommand, spawnArgs, cwd, cliInvocation };
}

function projectRootFromArgs(args) {
  const request = args.request || {};
  return path.resolve(args.projectRoot || request.projectRoot || workspaceRoot);
}

function renderSimpleHtmlPage({ title, body }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;margin:28px;color:#111827;background:#ffffff}
a{color:#0f766e} table{border-collapse:collapse;width:100%;margin:14px 0}
th,td{border:1px solid #d1d5db;padding:7px;text-align:left;vertical-align:top}
th{background:#f3f4f6} code{background:#f3f4f6;padding:2px 4px} pre{white-space:pre-wrap;max-width:900px}
.chip{display:inline-block;border-radius:999px;padding:3px 9px;background:#e5e7eb;margin-right:6px}
</style></head><body><h1>${htmlEscape(title)}</h1>${body}</body></html>`;
}

async function writeSupplementalCReportPages(outDir, report, targetFunctionFilter, artifacts) {
  const links = {};
  const functions = targetFunctionFilter?.functions || report?.mcpTargetFunctionFilter?.functions || [];
  const testcaseRows = [];
  for (const functionName of functions) {
    const functionDir = path.join(outDir, functionName);
    let tempDirs = [];
    try {
      tempDirs = readdirSync(functionDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^temp_(run|cbmc)_/i.test(entry.name));
    } catch {
      tempDirs = [];
    }
    for (const entry of tempDirs.slice(0, 200)) {
      const tempDir = path.join(functionDir, entry.name);
      const status = readFirstStatusCode(path.join(tempDir, "native_run.status"));
      const inputName = (() => {
        try {
          return readdirSync(tempDir).find((name) => /^input_.*\.txt$/i.test(name));
        } catch {
          return null;
        }
      })();
      const inputPath = inputName ? path.join(tempDir, inputName) : null;
      const inputText = inputPath ? truncate(readFileSync(inputPath, "utf8"), 1200) : "";
      const logPath = path.join(tempDir, "native_run.log");
      const logText = pathExists(logPath) ? truncate(readFileSync(logPath, "utf8"), 1000) : "";
      testcaseRows.push(`<tr><td>${htmlEscape(functionName)}</td><td>${htmlEscape(entry.name)}</td><td>${htmlEscape(status ?? "unknown")}</td><td><pre>${htmlEscape(inputText)}</pre></td><td><pre>${htmlEscape(logText)}</pre></td><td><code>${htmlEscape(logPath)}</code></td></tr>`);
    }
  }
  const tcPath = path.join(outDir, "reports", "testcase_io", "index.html");
  await mkdir(path.dirname(tcPath), { recursive: true });
  await writeFile(tcPath, renderSimpleHtmlPage({
    title: "Function Testcase I/O",
    body: `<p>Decoded testcase input/output evidence captured from generated PerfectOne native replay directories. Large runs are capped in this review page; raw artifacts remain under the function directories.</p><table><thead><tr><th>Function</th><th>Case</th><th>Exit</th><th>Input</th><th>Stdout/Stderr</th><th>Log</th></tr></thead><tbody>${testcaseRows.join("\n") || '<tr><td colspan="6">No native testcase I/O was found yet.</td></tr>'}</tbody></table>`
  }), "utf8");
  links.testcaseIo = tcPath;

  const designPath = path.join(outDir, "unit_design", "source_derived_design.md");
  await mkdir(path.dirname(designPath), { recursive: true });
  if (!pathExists(designPath)) {
    await writeFile(designPath, [
      "# Source-derived C Unit Design Draft",
      "",
      "This Markdown is generated from source targets and remains review-needed evidence until a reviewer approves the design/oracle assumptions.",
      "",
      "## Source Target Functions",
      "",
      ...functions.map((name) => `- ${name}: inferred source target; reviewStatus=needs_review`),
      "",
      "## Test Design Defaults",
      "",
      "- Coverage growth: required",
      "- Boundary value: required",
      "- Equivalence partition: required",
      "- UB/AB risk probes: conditional on source review",
      ""
    ].join("\n"), "utf8");
  }
  links.sourceDesignMd = designPath;

  const failureEvidence = report?.failureEvidence || collectFailureEvidence({ projectRoot: outDir, outDir, cliPath: null });
  const ubRows = (failureEvidence.cases || []).map((item) => {
    const easy = /139|segmentation|segfault/i.test(`${item.message || ""} ${item.actual || ""}`)
      ? "Segmentation fault: generated input likely reached invalid pointer/memory access. Keep it as UB evidence, not as coverage success."
      : /undefined|ubsan|overflow/i.test(`${item.message || ""} ${item.actual || ""}`)
        ? "Undefined behavior sanitizer evidence: review the triggering expression and expected behavior before approving the testcase."
        : "Runtime failure evidence collected during replay; inspect log and input before classifying as valid oracle evidence.";
    return `<tr><td>${htmlEscape(item.type)}</td><td>${htmlEscape(item.function || "unknown")}</td><td>${htmlEscape(item.testcaseId || "unknown")}</td><td>${htmlEscape(easy)}</td><td><pre>${htmlEscape(truncate(renderValue(item.input), 900))}</pre></td><td>${htmlEscape(renderArtifactSummary(item.artifacts))}</td></tr>`;
  }).join("\n");
  const ubPath = path.join(outDir, "reports", "ub_asan", "index.html");
  await mkdir(path.dirname(ubPath), { recursive: true });
  await writeFile(ubPath, renderSimpleHtmlPage({
    title: "UB / ASAN / Runtime Failure Interpretation",
    body: `<p>This page separates crash/sanitizer evidence from coverage failure. Crashing testcases are evidence for UB/AB risk and should not be counted as successful oracle checks unless explicitly approved.</p><table><thead><tr><th>Type</th><th>Function</th><th>Case</th><th>Interpretation</th><th>Triggering Input</th><th>Artifacts</th></tr></thead><tbody>${ubRows || '<tr><td colspan="6">No UB/ASAN/segfault evidence was collected.</td></tr>'}</tbody></table>`
  }), "utf8");
  links.ubAsan = ubPath;

  const limitRows = (report?.residualTargets || report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction || []).map((item) => `<tr><td>${htmlEscape(item.function || "unknown")}</td><td>${htmlEscape(item.reason || "coverage_below_goal")}</td><td>${htmlEscape(Object.keys(item.unmetMetrics || {}).join(", ") || "unknown")}</td><td>${htmlEscape(item.source || item.evidenceSource || "unknown")}</td></tr>`).join("\n");
  const coverageGoalRows = Object.entries(report?.coverage || {})
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([metric, value]) => {
      const numeric = typeof value === "number" ? value : Number(value);
      const passed = Number.isFinite(numeric) ? numeric >= C_COVERAGE_GOAL_PERCENT : null;
      return `<tr><td>${htmlEscape(metric)}</td><td>${htmlEscape(passed === null ? "unknown" : boolText(passed))}</td><td>${htmlEscape(value)}</td><td>${C_COVERAGE_GOAL_PERCENT}</td></tr>`;
    }).join("\n");
  const limitsPath = path.join(outDir, "reports", "coverage_limits", "index.html");
  await mkdir(path.dirname(limitsPath), { recursive: true });
  await writeFile(limitsPath, renderSimpleHtmlPage({
    title: "Coverage Limits and 100% Goal",
    body: `<p>The C verification goal is 100% for every reported coverage metric. Remaining gaps are separated from toolchain blockers and crash-risk cases without any file-specific historical threshold.</p><h2>100% Coverage Goal</h2><table><thead><tr><th>Metric</th><th>Passed</th><th>Actual %</th><th>Expected %</th></tr></thead><tbody>${coverageGoalRows || '<tr><td colspan="4">No coverage metrics were recorded yet.</td></tr>'}</tbody></table><h2>Residual / Limit Candidates</h2><table><thead><tr><th>Function</th><th>Reason</th><th>Unmet metrics</th><th>Evidence</th></tr></thead><tbody>${limitRows || '<tr><td colspan="4">No coverage limit candidates were recorded.</td></tr>'}</tbody></table>`
  }), "utf8");
  links.coverageLimits = limitsPath;

  return links;
}

function selectCoverageExecutionMode({ args, environment, toolchain, cliPath }) {
  const requestedRunner = String(args.runner || "auto").toLowerCase();
  const policy = String(args.runnerPolicy || "os-default").toLowerCase();
  const env = normalizeEnvironment(environment || {});
  const dockerAvailable = Boolean(toolchain.docker?.available);
  const nativeAvailable = nativeCoverageReady(toolchain);
  if (requestedRunner === "noop") return { runner: "noop", executionMode: "noop", reason: "noop_requested" };
  if (requestedRunner === "docker") return { runner: "docker", executionMode: "docker", reason: "docker_requested" };
  if (requestedRunner === "wsl") {
    return { runner: "wsl", executionMode: "unsupported", reason: "wsl_disabled" };
  }
  if (requestedRunner === "local") {
    if (env.hostOs === "windows") {
      return { runner: "none", executionMode: "none", reason: "windows_local_is_residual_only" };
    }
    return nativeAvailable
      ? { runner: "local", executionMode: "native", reason: "local_alias_requested" }
      : { runner: "none", executionMode: "none", reason: "needs_toolchain_setup" };
  }
  if (!["auto", ""].includes(requestedRunner)) {
    return { runner: requestedRunner, executionMode: requestedRunner, reason: "invalid_requested" };
  }
  if (policy === "docker-first") {
    if (dockerAvailable) return { runner: "docker", executionMode: "docker", reason: "policy_docker_first" };
    if (nativeAvailable && env.hostOs !== "windows") return { runner: "local", executionMode: "native", reason: "docker_unavailable_native_fallback" };
    return { runner: "none", executionMode: "none", reason: "needs_docker_setup" };
  }
  if (policy === "native-first") {
    if (env.hostOs !== "windows" && nativeAvailable) return { runner: "local", executionMode: "native", reason: "policy_native_first" };
    if (dockerAvailable) return { runner: "docker", executionMode: "docker", reason: "windows_native_disabled_docker_default" };
    return { runner: "none", executionMode: "none", reason: env.hostOs === "windows" ? "needs_docker_setup" : "needs_toolchain_setup" };
  }
  if (env.hostOs === "windows") {
    if (dockerAvailable) return { runner: "docker", executionMode: "docker", reason: "windows_default_docker" };
    return { runner: "none", executionMode: "none", reason: "needs_docker_setup" };
  } else if (["linux", "macos"].includes(env.hostOs)) {
    if (nativeAvailable) return { runner: "local", executionMode: "native", reason: `${env.hostOs}_default_native` };
  }
  return { runner: "none", executionMode: "none", reason: "needs_toolchain_setup" };
}

async function runFilteredCCoverageBlocking({ cliPath, args }) {
  const request = args.request || {};
  const projectRoot = path.resolve(args.projectRoot || request.projectRoot || workspaceRoot);
  const environment = normalizeEnvironment(args.environment || request.environment || {});
  const outDir = path.resolve(projectRoot, args.outDir || request.outDir || path.join(".perfectone", "unit-verify"));
  const irPath = path.resolve(projectRoot, args.ir || path.join(outDir, "ir.json"));
  const sourceFiles = Array.isArray(request.sourceFiles) && request.sourceFiles.length > 0
    ? request.sourceFiles
    : (Array.isArray(args.sourceFiles) ? args.sourceFiles : []);
  const filterRequest = {
    ...request,
    projectRoot,
    environment,
    sourceFiles
  };
  const targetFunctionFilter = await buildSourceTargetFilter(projectRoot, filterRequest, { irPath });
  const localToolchain = detectLocalToolchain({
    ...environment,
    language: request.language || "c",
    workspaceRoot
  });
  const diagnostics = [];
  const coverageOptions = {
    ...(request.coverageOptions || {}),
    ...(args.coverageOptions || {}),
    ...(request.executionProfile ? { executionProfile: request.executionProfile } : {}),
    ...(args.executionProfile ? { executionProfile: args.executionProfile } : {}),
    ...(request.replayMaxCasesPerFunction !== undefined ? { replayMaxCasesPerFunction: request.replayMaxCasesPerFunction } : {}),
    ...(args.replayMaxCasesPerFunction !== undefined ? { replayMaxCasesPerFunction: args.replayMaxCasesPerFunction } : {}),
    ...(request.replayDedup ? { replayDedup: request.replayDedup } : {}),
    ...(args.replayDedup ? { replayDedup: args.replayDedup } : {}),
    ...(request.nativeReplayTimeout !== undefined ? { nativeReplayTimeout: request.nativeReplayTimeout } : {}),
    ...(args.nativeReplayTimeout !== undefined ? { nativeReplayTimeout: args.nativeReplayTimeout } : {})
  };
  const coverageTuning = normalizeCoverageTuningOptions(coverageOptions, diagnostics);
  const sourceFile = targetFunctionFilter.sourceFiles?.[0] || null;
  const requestedRunner = String(args.runner || "auto").toLowerCase();
  const wslDirectRequested = false;
  const wslDirectDisabled = true;
  const dockerExplicit = requestedRunner !== "noop";
  const runId = `c-coverage-${Date.now()}`;

  if (!pathExists(irPath) && args.runner !== "noop") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "ir_not_found",
      message: `PerfectOne IR was not found: ${irPath}`,
      source: "mcp",
      blocking: true
    });
  }
  if (!targetFunctionFilter.generated) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "source_target_filter_unavailable",
      message: "No source-file C function definitions were available for filtered coverage.",
      source: "mcp",
      blocking: true
    });
  }

  const selection = selectCoverageExecutionMode({ args, environment, toolchain: localToolchain, cliPath });
  const runner = selection.runner;
  const executionMode = selection.executionMode;
  const dockerPreparationBefore = dockerPreparationStatus({ ...environment, dockerExplicit, autoStartDocker: executionMode === "docker" }, localToolchain);
  const dockerToolchain = executionMode === "docker"
    ? resolveDockerCoverageTools(coverageOptions, diagnostics)
    : null;
  if (runner === "wsl" || executionMode === "unsupported") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "wsl_runner_disabled",
      message: "WSL runner is disabled for this plugin path because artifact synchronization overhead is too high. Use Docker for PerfectOne KLEE baseline and Windows local LLVM/lld-link for residual native coverage.",
      source: "mcp",
      blocking: true
    });
  }
  if (!["docker", "local", "noop", "none"].includes(runner)) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "invalid_coverage_runner",
      message: `Invalid C coverage runner: ${runner}. Expected docker, local, auto, or noop. WSL is disabled.`,
      source: "mcp",
      blocking: true
    });
  }
  const canUseWslDirectCli = false;
  if (!cliPath && !["noop", "none"].includes(runner)) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "perfectone_cli_not_found",
      message: "Windows PerfectOne CLI was not found. Build or configure the single deployed ClangParserForWin.exe before running Docker C coverage.",
      source: "mcp",
      blocking: true
    });
  }
  if (runner === "none") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: selection.reason === "needs_docker_setup" ? "needs_docker_setup" : "needs_toolchain_setup",
      message: selection.reason === "needs_docker_setup"
        ? "Docker is required for the Windows PerfectOne KLEE baseline and is not ready."
        : "No supported C coverage runner is ready. Native KLEE/LLVM is incomplete.",
      source: "mcp",
      blocking: true
    });
  }
  if (executionMode === "docker" && (dockerPreparationBefore.firstRunWillPrepare || dockerPreparationBefore.repeatedPrepareLikely || dockerPreparationBefore.status === "configured_image_missing")) {
    pushDiagnostic(diagnostics, {
      severity: dockerPreparationBefore.status === "configured_image_missing" ? "error" : "warning",
      code: dockerPreparationBefore.status === "configured_image_missing" ? "docker_configured_image_missing" : "windows_docker_prepared_image_missing",
      message: dockerPreparationBefore.message,
      source: "mcp",
      blocking: dockerPreparationBefore.status === "configured_image_missing"
    });
  }
  if (executionMode === "docker" && !localToolchain.docker?.available) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "docker_unavailable",
      message: "Docker runner was explicitly selected, but Docker is not available on this host.",
      source: "mcp",
      blocking: true
    });
  }

  let result = { code: 2, stdout: "", stderr: "", timedOut: false, elapsedMs: null, startedAt: null, completedAt: null };
  let cliArgs = [];
  let cliCapabilities = null;
  let cliInvocation = {
    mode: "host",
    hostCliPath: cliPath || null,
    wslCli: null,
    directWslCliUsed: false,
    fallbackReason: null
  };
  let priorCoverageArtifactSnapshot = null;
  if (runner === "noop") {
    result = { code: 0, stdout: "noop coverage runner selected; command execution skipped", stderr: "", timedOut: false, elapsedMs: 0, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
  } else if (!diagnostics.some((item) => item.blocking)) {
    cliCapabilities = await probePerfectOneCliCapabilities(cliPath, { timeoutMs: args.capabilitiesTimeoutMs ?? 15000 });
    if (!cliCapabilities.cCoverageSupported) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "perfectone_cli_c_coverage_unsupported",
        message: `Selected PerfectOne CLI does not advertise c-coverage support: ${cliPath}. Deploy exactly one current ClangParserForWin.exe or set PERFECTONE_CLI to the current binary before running coverage.`,
        source: "mcp",
        blocking: true,
        details: {
          cliPath,
          phases: cliCapabilities.phases,
          cCoverageRunners: cliCapabilities.cCoverageRunners,
          exitCode: cliCapabilities.exitCode
        }
      });
    }
  }
  if (runner !== "noop" && !diagnostics.some((item) => item.blocking)) {
    priorCoverageArtifactSnapshot = await preserveCoverageArtifactsBeforeRun(outDir, executionMode, runId);
    if (executionMode === "docker") {
      cliArgs = dockerCoverageArgs({ irPath, outDir, sourceFile, regex: targetFunctionFilter.regex, coverageOptions, coverageTuning, dockerToolchain });
      result = await runCli(cliPath, cliArgs, {
        cwd: path.dirname(cliPath),
        timeoutMs: normalizeCoverageProcessTimeoutMs(args.coverageTimeoutMs ?? args.timeoutMs)
      });
    } else {
      cliArgs = nativeCoverageArgs({ irPath, outDir, sourceFile, regex: targetFunctionFilter.regex, coverageOptions, coverageTuning, runner, environment });
      cliInvocation = {
        ...cliInvocation,
        mode: "host",
        fallbackReason: null
      };
      result = await runCli(cliPath, cliArgs, {
        cwd: executionMode === "docker" ? path.dirname(cliPath) : projectRoot,
        timeoutMs: normalizeCoverageProcessTimeoutMs(args.coverageTimeoutMs ?? args.timeoutMs)
      });
    }
  }

  const artifacts = await coverageArtifactsForOutDir(outDir);
  const runProgress = summarizeCoverageProgress(outDir, targetFunctionFilter);
  for (const diagnostic of coverageAggregationDiagnostics(artifacts, executionMode)) {
    pushDiagnostic(diagnostics, diagnostic);
  }
  const residualTargets = await buildPerFunctionCoverageTargets(outDir, targetFunctionFilter, artifacts.coverage, C_COVERAGE_GOAL_PERCENT);
  const dockerPreparationAfter = executionMode === "docker"
    ? dockerPreparationStatus({ ...environment, dockerExplicit: true, autoStartDocker: true }, localToolchain)
    : dockerPreparationBefore;
  const dockerDiscovered = executionMode === "docker" ? parseDockerDiscoveredCount(result.stdout, result.stderr) : null;
  if (dockerDiscovered !== null && targetFunctionFilter.functionCount !== null && dockerDiscovered > targetFunctionFilter.functionCount) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "docker_discovered_non_source_targets",
      message: `Filtered Docker discovered ${dockerDiscovered} functions for ${targetFunctionFilter.functionCount} source targets. Header/system functions are still mixed into coverage.`,
      source: "mcp",
      blocking: true
    });
  }
  const coverageExecutionSucceeded = result.code === 0 && artifacts.lcov.exists;
  const carriedFunctionReports = Array.isArray(args.functionReports)
    ? args.functionReports
    : (Array.isArray(args.unitVerifyResult?.report?.functionReports)
      ? args.unitVerifyResult.report.functionReports
      : (Array.isArray(request.functionReports) ? request.functionReports : []));
  const needscodingAgentResidual = coverageExecutionSucceeded && residualTargets.length > 0;
  const hasUnitDesignArtifacts = Boolean(request.unitDesignArtifacts && (Array.isArray(request.unitDesignArtifacts) ? request.unitDesignArtifacts.length > 0 : true));
  const codingAgentTestAugmentationPlan = buildCodingAgentTestAugmentationPlan({
    language: request.language || "c",
    sourceFiles: targetFunctionFilter.sourceFiles || sourceFiles || [],
    hasSpecification: hasUnitDesignArtifacts,
    baselineKind: "PerfectOne filtered KLEE/MC/DC",
    baselineReady: coverageExecutionSucceeded,
    coverageExecution: null,
    residualTargets
  });
  const needsCodingAgentAugmentation = coverageExecutionSucceeded && !needscodingAgentResidual && codingAgentTestAugmentationPlan.executionRequired;
  const reportStatus = runner === "noop"
    ? (artifacts.lcov.exists ? (needscodingAgentResidual ? "needs_coding_agent_residual" : needsCodingAgentAugmentation ? "needs_coding_agent_augmentation" : "passed") : "needs_c_coverage_execution")
    : (coverageExecutionSucceeded ? (needscodingAgentResidual ? "needs_coding_agent_residual" : needsCodingAgentAugmentation ? "needs_coding_agent_augmentation" : "passed") : "failed");
  const executionDiagnostics = normalizeDiagnostics({
    report: {
      diagnostics,
      status: reportStatus
    },
    stderr: result.stderr,
    stdout: result.stdout,
    logText: "",
    localToolchain
  });
  const coverageExecution = {
    runner,
    runnerPolicy: args.runnerPolicy || "os-default",
    executionMode,
    selectionReason: selection.reason,
    environment,
    wslDistro: null,
    wslDirectRequested: false,
    wslDisabled: true,
    dockerExplicit: executionMode === "docker",
    cliInvocation,
    cliCapabilities,
    command: cliArgs,
    coverageOptions: coverageTuning,
    executionProfile: coverageTuning.executionProfile,
    replayPolicy: {
      replayMaxCasesPerFunction: coverageTuning.replayMaxCasesPerFunction,
      replayDedup: coverageTuning.replayDedup,
      nativeReplayTimeout: coverageTuning.nativeReplayTimeout,
      quickBaseline: coverageTuning.executionProfile === "quick",
      dockerKleeParallel: executionMode === "docker",
      windowsLocalResidualParallel: environment.hostOs === "windows",
      internalBatchParallel: false,
      nativeReplayParallelism: coverageOptions.kleeTestParallel ?? null
    },
    performance: {
      pathMode: artifacts.manifest.data?.runner === "docker" ? "docker-volume" : (artifacts.manifest.data?.runner || executionMode),
      scratchPath: null,
      wslInvocationCount: 0,
      testcaseCounts: artifacts.manifest.data?.testcase_counts ?? null,
      replayDedup: artifacts.manifest.data?.replay_dedup ?? coverageTuning.replayDedup,
      nativeReplayTimeoutSec: artifacts.manifest.data?.native_replay_timeout_sec ?? coverageTuning.nativeReplayTimeout
    },
    runnerCommands: artifacts.manifest.data?.runner_commands || null,
    priorCoverageArtifactSnapshot,
    docker: {
      attempted: executionMode === "docker",
      executed: executionMode === "docker" && result.code === 0,
      filtered: true,
      requiredFuncRegex: targetFunctionFilter.regex,
      toolchain: dockerToolchain,
      preparation: {
        before: dockerPreparationBefore,
        after: dockerPreparationAfter
      }
    },
    wsl: { attempted: false, executed: false, disabled: true, reason: "artifact_sync_overhead" },
    local: { attempted: executionMode === "native", executed: executionMode === "native" && result.code === 0 },
    native: { attempted: executionMode === "native", executed: executionMode === "native" && result.code === 0 },
    klee: {
      attempted: runner !== "noop",
      executed: runProgress.kleeCompleted > 0 || runProgress.kleePartial > 0 || (/KLEE run complete|completed KLEE|klee/i.test(result.stdout) && result.code === 0),
      status: runProgress.kleePartial > 0 && runProgress.kleeCompleted < (runProgress.totalFunctions || runProgress.kleeCompleted + runProgress.kleePartial)
        ? "partial_timeout"
        : (runProgress.kleeCompleted > 0 ? "completed" : "not_executed"),
      completedFunctions: runProgress.kleeCompleted,
      partialFunctions: runProgress.kleePartial
    },
    mcdc: {
      attempted: runner !== "noop",
      measured: Boolean(artifacts.coverage?.mcdc?.total),
      value: artifacts.coverage?.mcdc?.pct ?? null
    },
    residualMcdcStrategy: {
      defaultPath: environment.hostOs === "windows" ? "windows-local-llvm-lld-link" : "local-native-coverage",
      baselineKleePath: executionMode,
      windowsLocalMcdc: localToolchain.windowsLocalMcdc || null,
      parallelPolicy: environment.hostOs === "windows"
        ? "Docker runs source-target filtered KLEE in parallel; Windows local LLVM/lld-link runs Coding Agent residual native replay and coverage aggregation in parallel where generated artifacts do not conflict"
        : "run independent Coding Agent residual harness compile/replay/coverage jobs in parallel where generated artifacts do not conflict",
      fallbackOrder: environment.hostOs === "windows"
        ? ["docker-klee-baseline", "windows-local-llvm-lld-link", "local-no-klee"]
        : ["local-native-coverage", "explicit-docker", "local-no-klee"]
    },
    goal: {
      line: C_COVERAGE_GOAL_PERCENT,
      branch: C_COVERAGE_GOAL_PERCENT,
      function: C_COVERAGE_GOAL_PERCENT,
      mcdc: C_COVERAGE_GOAL_PERCENT
    },
    coverage: artifacts.coverage,
    residualTargets,
    targetSourceFiles: targetFunctionFilter.sourceFiles || [],
    filterSource: targetFunctionFilter.filterSource || null,
    functionRegex: targetFunctionFilter.regex || null,
    artifacts: {
      lcov: artifacts.lcov,
      manifest: { path: artifacts.manifest.path, exists: artifacts.manifest.exists },
      aggregateLog: { path: artifacts.aggregateLog.path, exists: artifacts.aggregateLog.exists },
      html: artifacts.html,
      summaryHtml: artifacts.summaryHtml
    },
    candidateCounts: {
      sourceTargets: targetFunctionFilter.functionCount,
      mcpFunctionReports: carriedFunctionReports.length || null,
      dockerDiscovered
    },
    timing: {
      replayMs: result.elapsedMs,
      startedAt: result.startedAt,
      completedAt: result.completedAt
    }
  };
  codingAgentTestAugmentationPlan.coverageExecution = {
    executionMode: coverageExecution.executionMode,
    runner: coverageExecution.runner,
    kleeExecuted: Boolean(coverageExecution.klee?.executed),
    mcdcMeasured: Boolean(coverageExecution.mcdc?.measured),
    coverage: coverageExecution.coverage || null
  };
  const codingAgentResidualRepairPlan = buildCodingAgentResidualRepairPlan({ residualTargets, targetFunctionFilter, coverageExecution });
  const codingAgentResidualRepairPrompt = buildCodingAgentResidualRepairPrompt(codingAgentResidualRepairPlan);
  const codingAgentResidualActionRequired = buildCodingAgentResidualActionRequired(codingAgentResidualRepairPlan, coverageExecution);
  const codingAgentTestAugmentationPrompt = buildCodingAgentTestAugmentationPrompt(codingAgentTestAugmentationPlan);
  const codingAgentTestAugmentationActionRequired = buildCodingAgentTestAugmentationActionRequired(codingAgentTestAugmentationPlan);
  const primaryActionRequired = codingAgentResidualActionRequired.required
    ? codingAgentResidualActionRequired
    : (codingAgentTestAugmentationActionRequired.required ? codingAgentTestAugmentationActionRequired : codingAgentResidualActionRequired);
  const codingAgentResidualActions = [
    ...(codingAgentResidualRepairPlan.instructions || []),
    ...(codingAgentTestAugmentationPlan.instructions || [])
  ];

  const effectiveReportStatus = reportStatus;

  const report = {
    schemaVersion: "perfectone.unitverify.c.coverage.report.v1",
    runId,
    status: effectiveReportStatus,
    coverage: {
      line: artifacts.coverage?.line?.pct ?? null,
      branch: artifacts.coverage?.branch?.pct ?? null,
      function: artifacts.coverage?.function?.pct ?? null,
      mcdc: artifacts.coverage?.mcdc?.pct ?? null
    },
    functions: [],
    artifacts: [],
    diagnostics: executionDiagnostics,
    recommendedActions: codingAgentResidualActions,
    codingPlatformActions: codingAgentResidualActions,
    codingPlatformPrompt: [codingAgentResidualRepairPrompt, codingAgentTestAugmentationPrompt].filter(Boolean).join("\n\n"),
    codingAgentResidualRepairPlan,
    codingAgentResidualRepairPrompt,
    codingAgentResidualActionRequired,
    codingAgentTestAugmentationPlan,
    codingAgentTestAugmentationPrompt,
    codingAgentTestAugmentationActionRequired,
    actionRequired: primaryActionRequired,
    completionBlocked: Boolean(primaryActionRequired.completionBlocked),
    finalAnswerAllowed: primaryActionRequired.finalAnswerAllowed !== false,
    nextRequiredAction: primaryActionRequired.nextRequiredAction,
    localToolchain,
    toolchainEnvironment: detectToolchainEnvironment({ projectRoot, language: request.language || "c", sourceFiles, environment }),
    targetSourceFiles: targetFunctionFilter.sourceFiles || [],
    filterSource: targetFunctionFilter.filterSource || null,
    functionRegex: targetFunctionFilter.regex || null,
    mcpTargetFunctionFilter: targetFunctionFilter,
    functionReports: carriedFunctionReports,
    residualTargets,
    cUnitVerificationFlow: buildCUnitVerificationFlow({
      report: { status: effectiveReportStatus },
      targetFunctionFilter,
      functionReports: carriedFunctionReports,
      result: { elapsedMs: null },
      coverageExecution,
      residualTargets,
      testAugmentationPlan: codingAgentTestAugmentationPlan
    })
  };
  report.failureEvidence = collectFailureEvidence({ projectRoot, outDir, cliPath });
  report.cUnitVerificationFlow.failureEvidenceSummary = report.failureEvidence.summary;
  report.reportLinks = await writeSupplementalCReportPages(outDir, report, targetFunctionFilter, artifacts);
  const shouldProtectExistingCoverageReport = executionMode === "native" && priorCoverageArtifactSnapshot?.status === "preserved" && result.code !== 0;
  const reportBaseName = shouldProtectExistingCoverageReport
    ? `perfectone_mcp_report_${slug(runId)}_${slug(executionMode)}`
    : "perfectone_mcp_report";
  if (shouldProtectExistingCoverageReport) {
    pushDiagnostic(report.diagnostics, {
      severity: "warning",
      code: "coverage_report_overwrite_guard",
      message: `A failed ${executionMode} follow-up coverage run preserved earlier coverage artifacts and wrote a separate MCP report (${reportBaseName}) instead of overwriting the canonical report.`,
      source: "mcp",
      blocking: false
    });
  }
  let diagnosticSummary = summarizeDiagnostics(report.diagnostics);
  report.diagnosticSummary = diagnosticSummary;
  report.tokenUsage = buildPluginTokenUsage({
    inputPayloads: [
      { name: "filteredCoverageArgs", value: args, surface: "mcp" },
      { name: "filteredCoverageRequest", value: request, surface: "mcp" },
      { name: "sourceTargetFilter", value: targetFunctionFilter, surface: "mcp" }
    ],
    outputPayloads: [
      { name: "cliStdout", value: result.stdout, surface: "cli" },
      { name: "cliStderr", value: result.stderr, surface: "cli" },
      { name: "coverageExecution", value: coverageExecution, surface: "mcp" },
      { name: "codingAgentResidualRepairPlan", value: codingAgentResidualRepairPlan, surface: "mcp" },
      { name: "codingAgentResidualActionRequired", value: codingAgentResidualActionRequired, surface: "mcp" },
      { name: "codingAgentResidualRepairPrompt", value: codingAgentResidualRepairPrompt, surface: "skill" },
      { name: "codingAgentTestAugmentationPlan", value: codingAgentTestAugmentationPlan, surface: "mcp" },
      { name: "codingAgentTestAugmentationPrompt", value: codingAgentTestAugmentationPrompt, surface: "skill" },
      { name: "coverageReport", value: reportWithoutTokenUsage(report), surface: "report" }
    ]
  });
  diagnosticSummary = summarizeDiagnostics(report.diagnostics);
  report.diagnosticSummary = diagnosticSummary;
  const generatedReports = await writeReportBundle(outDir, report, diagnosticSummary, { reportBaseName });
  report.artifacts = generatedReports;
  const topStatus = diagnostics.some((item) => item.code === "needs_toolchain_setup")
    ? "needs_toolchain_setup"
    : report.status;

  return {
    status: topStatus,
    mcpStatus: topStatus,
    cliPath,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    outDir,
    ir: irPath,
    runner,
    executionMode,
    runnerPolicy: args.runnerPolicy || "os-default",
    sourceTargetFilter: targetFunctionFilter,
    coverageExecution,
    report,
    recommendedActions: report.recommendedActions,
    codingPlatformActions: report.codingPlatformActions,
    codingPlatformPrompt: report.codingPlatformPrompt,
    codingAgentResidualRepairPlan,
    codingAgentResidualRepairPrompt,
    codingAgentResidualActionRequired,
    codingAgentTestAugmentationPlan,
    codingAgentTestAugmentationPrompt,
    codingAgentTestAugmentationActionRequired,
    actionRequired: primaryActionRequired,
    completionBlocked: Boolean(primaryActionRequired.completionBlocked),
    finalAnswerAllowed: primaryActionRequired.finalAnswerAllowed !== false,
    nextRequiredAction: primaryActionRequired.nextRequiredAction,
    stderr: truncate(result.stderr),
    stdout: truncate(result.stdout),
    diagnostics: report.diagnostics,
    diagnosticSummary,
    blockingDiagnostics: report.diagnostics.filter((item) => item.blocking),
    failureEvidence: report.failureEvidence,
    tokenUsage: report.tokenUsage
  };
}

async function prepareCoverageJobInvocation({ cliPath, args }) {
  const request = args.request || {};
  const projectRoot = projectRootFromArgs(args);
  const environment = normalizeEnvironment(args.environment || request.environment || {});
  const outDir = path.resolve(projectRoot, args.outDir || request.outDir || path.join(".perfectone", "unit-verify"));
  const irPath = path.resolve(projectRoot, args.ir || path.join(outDir, "ir.json"));
  const sourceFiles = Array.isArray(request.sourceFiles) && request.sourceFiles.length > 0
    ? request.sourceFiles
    : (Array.isArray(args.sourceFiles) ? args.sourceFiles : []);
  const filterRequest = { ...request, projectRoot, environment, sourceFiles };
  const diagnostics = [];
  const targetFunctionFilter = await buildSourceTargetFilter(projectRoot, filterRequest, { irPath });
  const localToolchain = detectLocalToolchain({
    ...environment,
    language: request.language || "c",
    workspaceRoot
  });
  const coverageOptions = {
    ...(request.coverageOptions || {}),
    ...(args.coverageOptions || {}),
    ...(request.executionProfile ? { executionProfile: request.executionProfile } : {}),
    ...(args.executionProfile ? { executionProfile: args.executionProfile } : {}),
    ...(request.replayMaxCasesPerFunction !== undefined ? { replayMaxCasesPerFunction: request.replayMaxCasesPerFunction } : {}),
    ...(args.replayMaxCasesPerFunction !== undefined ? { replayMaxCasesPerFunction: args.replayMaxCasesPerFunction } : {}),
    ...(request.replayDedup ? { replayDedup: request.replayDedup } : {}),
    ...(args.replayDedup ? { replayDedup: args.replayDedup } : {}),
    ...(request.nativeReplayTimeout !== undefined ? { nativeReplayTimeout: request.nativeReplayTimeout } : {}),
    ...(args.nativeReplayTimeout !== undefined ? { nativeReplayTimeout: args.nativeReplayTimeout } : {})
  };
  const coverageTuning = normalizeCoverageTuningOptions(coverageOptions, diagnostics);
  const wslDirectRequested = false;
  const wslDirectDisabled = true;
  const selection = selectCoverageExecutionMode({ args, environment, toolchain: localToolchain, cliPath });
  const runner = selection.runner;
  const executionMode = selection.executionMode;
  const dockerToolchain = executionMode === "docker"
    ? resolveDockerCoverageTools(coverageOptions, diagnostics)
    : null;
  if (!pathExists(irPath) && runner !== "noop") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "ir_not_found",
      message: `PerfectOne IR was not found: ${irPath}`,
      source: "mcp",
      blocking: true
    });
  }
  if (!targetFunctionFilter.generated) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "source_target_filter_unavailable",
      message: "No source-file C function definitions were available for filtered coverage.",
      source: "mcp",
      blocking: true
    });
  }
  if (runner === "none") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: selection.reason === "needs_docker_setup" ? "needs_docker_setup" : "needs_toolchain_setup",
      message: selection.reason === "needs_docker_setup"
        ? "Docker is required for the Windows PerfectOne KLEE baseline and is not ready."
        : "No supported C coverage runner is ready. Native KLEE/LLVM is incomplete.",
      source: "mcp",
      blocking: true
    });
  }
  if (runner === "wsl" || executionMode === "unsupported") {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "wsl_runner_disabled",
      message: "WSL runner is disabled for this plugin path because artifact synchronization overhead is too high.",
      source: "mcp",
      blocking: true
    });
  }
  if (!["docker", "local", "noop", "none"].includes(runner)) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "invalid_coverage_runner",
      message: `Invalid C coverage runner: ${runner}. Expected docker, local, auto, or noop. WSL is disabled.`,
      source: "mcp",
      blocking: true
    });
  }
  if (!cliPath && !["noop", "none"].includes(runner)) {
    pushDiagnostic(diagnostics, {
      severity: "error",
      code: "perfectone_cli_not_found",
      message: "PerfectOne CLI was not found. Provide the single current prebuilt CLI through perfectoneCli or PERFECTONE_CLI.",
      source: "mcp",
      blocking: true
    });
  }
  const sourceFile = targetFunctionFilter.sourceFiles?.[0] || null;
  const invocation = coverageInvocationForJob({
    cliPath,
    args,
    outDir,
    irPath,
    sourceFile,
    targetFunctionFilter,
    selection,
    localToolchain,
    coverageOptions,
    coverageTuning,
    dockerToolchain,
    environment,
    wslDirectRequested,
    wslDirectDisabled
  });
  return {
    request,
    projectRoot,
    environment,
    outDir,
    irPath,
    sourceFiles,
    targetFunctionFilter,
    localToolchain,
    diagnostics,
    coverageOptions,
    coverageTuning,
    selection,
    runner,
    executionMode,
    dockerToolchain,
    invocation,
    wslDirectRequested
  };
}

async function startFilteredCCoverageJob({ cliPath, args }) {
  const prepared = await prepareCoverageJobInvocation({ cliPath, args });
  const blocking = prepared.diagnostics.filter((item) => item.blocking);
  if (blocking.length > 0) {
    return {
      status: "failed",
      mcpStatus: "failed",
      diagnostics: prepared.diagnostics,
      diagnosticSummary: summarizeDiagnostics(prepared.diagnostics),
      blockingDiagnostics: blocking,
      outDir: prepared.outDir,
      runner: prepared.runner,
      executionMode: prepared.executionMode,
      sourceTargetFilter: prepared.targetFunctionFilter
    };
  }
  const jobId = `c-coverage-job-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const runId = `c-coverage-${Date.now()}`;
  const paths = coverageJobPaths(prepared.outDir, jobId);
  const startedAt = new Date().toISOString();
  const requestedTimeoutMs = args.coverageTimeoutMs ?? args.timeoutMs ?? null;
  const timeoutMs = normalizeCoverageProcessTimeoutMs(requestedTimeoutMs);
  const baseStatus = {
    schemaVersion: "perfectone.coverage-job.status.v1",
    jobId,
    runId,
    status: prepared.runner === "noop" ? "completed" : "running",
    startedAt,
    completedAt: prepared.runner === "noop" ? startedAt : null,
    outDir: prepared.outDir,
    ir: prepared.irPath,
    runner: prepared.runner,
    executionMode: prepared.executionMode,
    environment: prepared.environment,
    windowsLocalMcdc: prepared.localToolchain?.windowsLocalMcdc || null,
    runnerPolicy: args.runnerPolicy || "os-default",
    coverageOptions: prepared.coverageTuning,
    executionProfile: prepared.coverageTuning.executionProfile,
    wslDisabled: true,
    replayPolicy: {
      replayMaxCasesPerFunction: prepared.coverageTuning.replayMaxCasesPerFunction,
      replayDedup: prepared.coverageTuning.replayDedup,
      nativeReplayTimeout: prepared.coverageTuning.nativeReplayTimeout,
      quickBaseline: prepared.coverageTuning.executionProfile === "quick",
      internalBatchParallel: false,
      dockerKleeParallel: prepared.executionMode === "docker",
      windowsLocalResidualParallel: prepared.environment.hostOs === "windows"
    },
    nextPollAfterMs: COVERAGE_JOB_POLL_MS,
    sourceTargetFilter: prepared.targetFunctionFilter,
    functionReports: args.functionReports || args.unitVerifyResult?.report?.functionReports || prepared.request.functionReports || [],
    cliPath,
    command: prepared.invocation.command,
    statusPath: paths.statusPath,
    progressPath: paths.progressPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    diagnostics: prepared.diagnostics
  };
  await writeJson(paths.statusPath, baseStatus);
  await writeJson(paths.progressPath, summarizeCoverageProgress(prepared.outDir, prepared.targetFunctionFilter));
  await writeJson(paths.commandPath, {
    command: prepared.invocation.command,
    cwd: prepared.invocation.cwd,
    cliInvocation: prepared.invocation.cliInvocation,
    timeoutMs,
    requestedTimeoutMs,
    timeoutPolicy: "coverage jobs clamp child process timeout to at least 30 minutes; MCP call timeout is not the same as coverage execution timeout"
  });
  if (prepared.runner === "noop") {
    coverageJobs.set(jobId, { ...baseStatus, child: null, paths, args, cliPath });
    return {
      status: "completed",
      mcpStatus: "completed",
      jobId,
      runId,
      outDir: prepared.outDir,
      statusPath: paths.statusPath,
      progressPath: paths.progressPath,
      nextPollAfterMs: COVERAGE_JOB_POLL_MS,
      sourceTargetFilter: prepared.targetFunctionFilter
    };
  }
  const stdout = createWriteStream(paths.stdoutPath, { flags: "a" });
  const stderr = createWriteStream(paths.stderrPath, { flags: "a" });
  const child = spawn(prepared.invocation.spawnCommand, prepared.invocation.spawnArgs, {
    cwd: prepared.invocation.cwd || undefined,
    windowsHide: true,
    env: { ...process.env, ...(args.env || {}) }
  });
  const job = { ...baseStatus, child, paths, args, cliPath, prepared, timedOut: false };
  coverageJobs.set(jobId, job);
  const timer = timeoutMs === null ? null : setTimeout(() => {
    job.timedOut = true;
    try {
      child.kill();
    } catch {
      // ignore kill failures
    }
  }, timeoutMs);
  const updateProgress = async () => {
    const progress = summarizeCoverageProgress(prepared.outDir, prepared.targetFunctionFilter);
    await writeJson(paths.progressPath, progress).catch(() => {});
  };
  child.stdout.on("data", (chunk) => {
    stdout.write(chunk);
    updateProgress();
  });
  child.stderr.on("data", (chunk) => {
    stderr.write(chunk);
    updateProgress();
  });
  child.on("error", async (error) => {
    if (timer) clearTimeout(timer);
    stdout.end();
    stderr.end();
    const completedAt = new Date().toISOString();
    const status = {
      ...baseStatus,
      status: "failed",
      completedAt,
      exitCode: 127,
      error: String(error),
      timedOut: job.timedOut
    };
    await writeJson(paths.statusPath, status).catch(() => {});
    await updateProgress();
    coverageJobs.set(jobId, { ...job, ...status });
  });
  child.on("close", async (code) => {
    if (timer) clearTimeout(timer);
    stdout.end();
    stderr.end();
    const completedAt = new Date().toISOString();
    const status = {
      ...baseStatus,
      status: code === 0 ? "completed" : "failed",
      completedAt,
      exitCode: code,
      timedOut: job.timedOut
    };
    await writeJson(paths.statusPath, status).catch(() => {});
    await updateProgress();
    coverageJobs.set(jobId, { ...job, ...status });
  });
  return {
    status: "started",
    mcpStatus: "started",
    jobId,
    runId,
    outDir: prepared.outDir,
    runner: prepared.runner,
    executionMode: prepared.executionMode,
    runnerPolicy: args.runnerPolicy || "os-default",
    statusPath: paths.statusPath,
    progressPath: paths.progressPath,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    startedAt,
    nextPollAfterMs: COVERAGE_JOB_POLL_MS,
    sourceTargetFilter: prepared.targetFunctionFilter,
    candidateCounts: {
      sourceTargets: prepared.targetFunctionFilter.functionCount,
      mcpFunctionReports: baseStatus.functionReports.length || null,
      dockerDiscovered: null
    },
    message: "C coverage is running in the background. Poll perfectone_get_coverage_job_status every 30 seconds and report progress to the user."
  };
}

async function getCoverageJobStatus(args) {
  const jobId = args.jobId;
  const inMemory = jobId ? coverageJobs.get(jobId) : null;
  const statusPath = args.statusPath || inMemory?.paths?.statusPath;
  const outDir = args.outDir || inMemory?.outDir || inMemory?.prepared?.outDir;
  const status = readJsonWithFallbackSync(statusPath, inMemory ? { ...inMemory, child: undefined, prepared: undefined } : null);
  const targetFunctionFilter = status?.sourceTargetFilter || inMemory?.prepared?.targetFunctionFilter || null;
  const progress = outDir ? summarizeCoverageProgress(outDir, targetFunctionFilter) : readJsonWithFallbackSync(args.progressPath || inMemory?.paths?.progressPath, {});
  if (args.progressPath || inMemory?.paths?.progressPath) {
    await writeJson(args.progressPath || inMemory.paths.progressPath, progress).catch(() => {});
  }
  return {
    status: status?.status || "unknown",
    mcpStatus: status?.status || "unknown",
    jobId: status?.jobId || jobId || null,
    runId: status?.runId || null,
    outDir: status?.outDir || outDir || null,
    statusPath: statusPath || null,
    progressPath: args.progressPath || inMemory?.paths?.progressPath || null,
    nextPollAfterMs: COVERAGE_JOB_POLL_MS,
    ...progress,
    exitCode: status?.exitCode ?? null,
    timedOut: Boolean(status?.timedOut),
    startedAt: status?.startedAt || null,
    completedAt: status?.completedAt || null,
    command: status?.command || null,
    runner: status?.runner || null,
    executionMode: status?.executionMode || null,
    executionProfile: status?.executionProfile || status?.coverageOptions?.executionProfile || null,
    wslDisabled: true,
    replayPolicy: status?.replayPolicy || null,
    coverageOptions: status?.coverageOptions || null,
    diagnostics: status?.diagnostics || []
  };
}

async function collectCoverageJobResult(args) {
  const statusResult = await getCoverageJobStatus(args);
  if (["running", "started"].includes(statusResult.status)) {
    return {
      ...statusResult,
      status: "running",
      mcpStatus: "running",
      message: "Coverage job is still running; continue 30 second polling."
    };
  }
  const status = readJsonWithFallbackSync(args.statusPath, null) || (args.jobId ? readJsonWithFallbackSync(coverageJobs.get(args.jobId)?.paths?.statusPath, null) : null) || {};
  const outDir = path.resolve(args.outDir || status.outDir || workspaceRoot);
  const reusedPreviousRun = Boolean(args.reusePreviousRun || status.reusePreviousRun);
  const targetFunctionFilter = status.sourceTargetFilter || args.sourceTargetFilter || null;
  const artifacts = await coverageArtifactsForOutDir(outDir);
  const diagnostics = [...(status.diagnostics || [])];
  for (const diagnostic of coverageAggregationDiagnostics(artifacts, status.executionMode || "unknown")) {
    pushDiagnostic(diagnostics, diagnostic);
  }
  const residualTargets = await buildPerFunctionCoverageTargets(outDir, targetFunctionFilter, artifacts.coverage, C_COVERAGE_GOAL_PERCENT);
  const progress = summarizeCoverageProgress(outDir, targetFunctionFilter);
  const coverageExecutionSucceeded = artifacts.lcov.exists && (status.exitCode === 0 || (reusedPreviousRun && (status.exitCode === null || status.exitCode === undefined)));
  const reportStatus = coverageExecutionSucceeded
    ? (residualTargets.length > 0 ? "needs_coding_agent_residual" : "needs_coding_agent_augmentation")
    : "failed";
  const effectiveReportStatus = reportStatus;
  const functionReports = status.functionReports || args.functionReports || [];
  const coverageExecution = {
    runner: status.runner || "unknown",
    reusedPreviousRun,
    runnerPolicy: status.runnerPolicy || "os-default",
    executionMode: status.executionMode || "unknown",
    wslDistro: null,
    wslDisabled: true,
    dockerExplicit: status.executionMode === "docker",
    command: status.command || null,
    coverageOptions: status.coverageOptions || null,
    executionProfile: status.executionProfile || status.coverageOptions?.executionProfile || "quick",
    replayPolicy: status.replayPolicy || {
      replayMaxCasesPerFunction: status.coverageOptions?.replayMaxCasesPerFunction ?? null,
      replayDedup: status.coverageOptions?.replayDedup ?? null,
      nativeReplayTimeout: status.coverageOptions?.nativeReplayTimeout ?? null,
      quickBaseline: (status.executionProfile || status.coverageOptions?.executionProfile || "quick") === "quick",
      internalBatchParallel: false,
      dockerKleeParallel: status.executionMode === "docker",
      windowsLocalResidualParallel: (status.environment?.hostOs || "windows") === "windows"
    },
    performance: {
      pathMode: artifacts.manifest.data?.runner === "docker" ? "docker-volume" : (artifacts.manifest.data?.runner || status.executionMode || "unknown"),
      scratchPath: null,
      wslInvocationCount: 0,
      testcaseCounts: artifacts.manifest.data?.testcase_counts ?? null,
      replayDedup: artifacts.manifest.data?.replay_dedup ?? status.replayPolicy?.replayDedup ?? null,
      nativeReplayTimeoutSec: artifacts.manifest.data?.native_replay_timeout_sec ?? status.replayPolicy?.nativeReplayTimeout ?? null
    },
    runnerCommands: artifacts.manifest.data?.runner_commands || null,
    docker: { attempted: status.executionMode === "docker", executed: status.executionMode === "docker" && status.exitCode === 0, filtered: true, requiredFuncRegex: targetFunctionFilter?.regex || null },
    wsl: { attempted: false, executed: false, disabled: true, reason: "artifact_sync_overhead" },
    local: { attempted: status.executionMode === "native", executed: status.executionMode === "native" && status.exitCode === 0 },
    native: { attempted: status.executionMode === "native", executed: status.executionMode === "native" && status.exitCode === 0 },
    klee: {
      attempted: true,
      executed: progress.kleeCompleted > 0 || progress.kleePartial > 0,
      status: progress.kleePartial > 0 ? "partial_timeout" : (progress.kleeCompleted > 0 ? "completed" : "not_executed"),
      completedFunctions: progress.kleeCompleted,
      partialFunctions: progress.kleePartial
    },
    mcdc: {
      attempted: true,
      measured: Boolean(artifacts.coverage?.mcdc?.total),
      value: artifacts.coverage?.mcdc?.pct ?? null
    },
    residualMcdcStrategy: {
      defaultPath: (status.environment?.hostOs || "windows") === "windows" ? "windows-local-llvm-lld-link" : "local-native-coverage",
      baselineKleePath: status.executionMode || "unknown",
      windowsLocalMcdc: status.windowsLocalMcdc || detectWindowsLocalMcdcToolchain(status.environment || {}),
      parallelPolicy: (status.environment?.hostOs || "windows") === "windows"
        ? "Docker runs source-target filtered KLEE in parallel; Windows local LLVM/lld-link runs residual native replay and coverage aggregation in parallel where generated artifacts do not conflict"
        : "run independent Coding Agent residual harness compile/replay/coverage jobs in parallel where generated artifacts do not conflict",
      fallbackOrder: (status.environment?.hostOs || "windows") === "windows"
        ? ["docker-klee-baseline", "windows-local-llvm-lld-link", "local-no-klee"]
        : ["local-native-coverage", "explicit-docker", "local-no-klee"]
    },
    coverage: artifacts.coverage,
    residualTargets,
    targetSourceFiles: targetFunctionFilter?.sourceFiles || [],
    filterSource: targetFunctionFilter?.filterSource || null,
    functionRegex: targetFunctionFilter?.regex || null,
    artifacts: {
      lcov: artifacts.lcov,
      manifest: { path: artifacts.manifest.path, exists: artifacts.manifest.exists },
      aggregateLog: { path: artifacts.aggregateLog.path, exists: artifacts.aggregateLog.exists },
      html: artifacts.html,
      summaryHtml: artifacts.summaryHtml
    },
    candidateCounts: {
      sourceTargets: targetFunctionFilter?.functionCount ?? null,
      mcpFunctionReports: functionReports.length || null,
      dockerDiscovered: null
    },
    timing: {
      replayMs: status.startedAt && status.completedAt ? new Date(status.completedAt).getTime() - new Date(status.startedAt).getTime() : null,
      startedAt: status.startedAt || null,
      completedAt: status.completedAt || null
    },
    progress
  };
  const codingAgentTestAugmentationPlan = buildCodingAgentTestAugmentationPlan({
    language: "c",
    sourceFiles: targetFunctionFilter?.sourceFiles || [],
    hasSpecification: false,
    baselineKind: "PerfectOne filtered KLEE/MC/DC",
    baselineReady: coverageExecutionSucceeded,
    coverageExecution,
    residualTargets
  });
  const codingAgentResidualRepairPlan = buildCodingAgentResidualRepairPlan({ residualTargets, targetFunctionFilter, coverageExecution });
  const codingAgentResidualRepairPrompt = buildCodingAgentResidualRepairPrompt(codingAgentResidualRepairPlan);
  const codingAgentResidualActionRequired = buildCodingAgentResidualActionRequired(codingAgentResidualRepairPlan, coverageExecution);
  const codingAgentTestAugmentationPrompt = buildCodingAgentTestAugmentationPrompt(codingAgentTestAugmentationPlan);
  const codingAgentTestAugmentationActionRequired = buildCodingAgentTestAugmentationActionRequired(codingAgentTestAugmentationPlan);
  const primaryActionRequired = codingAgentResidualActionRequired.required
    ? codingAgentResidualActionRequired
    : (codingAgentTestAugmentationActionRequired.required ? codingAgentTestAugmentationActionRequired : codingAgentResidualActionRequired);
  const report = {
    schemaVersion: "perfectone.unitverify.c.coverage.report.v1",
    runId: status.runId || args.jobId || `c-coverage-${Date.now()}`,
    status: effectiveReportStatus,
    coverage: {
      line: artifacts.coverage?.line?.pct ?? null,
      branch: artifacts.coverage?.branch?.pct ?? null,
      function: artifacts.coverage?.function?.pct ?? null,
      mcdc: artifacts.coverage?.mcdc?.pct ?? null
    },
    diagnostics,
    functionReports,
    residualTargets,
    codingAgentResidualRepairPlan,
    codingAgentResidualRepairPrompt,
    codingAgentResidualActionRequired,
    codingAgentTestAugmentationPlan,
    codingAgentTestAugmentationPrompt,
    codingAgentTestAugmentationActionRequired,
    actionRequired: primaryActionRequired,
    completionBlocked: Boolean(primaryActionRequired.completionBlocked),
    finalAnswerAllowed: primaryActionRequired.finalAnswerAllowed !== false,
    nextRequiredAction: primaryActionRequired.nextRequiredAction,
    mcpTargetFunctionFilter: targetFunctionFilter,
    cUnitVerificationFlow: buildCUnitVerificationFlow({
      report: { status: effectiveReportStatus },
      targetFunctionFilter,
      functionReports,
      result: { elapsedMs: null },
      coverageExecution,
      residualTargets,
      testAugmentationPlan: codingAgentTestAugmentationPlan
    })
  };
  report.failureEvidence = collectFailureEvidence({ projectRoot: outDir, outDir, cliPath: status.cliPath || null });
  report.cUnitVerificationFlow.failureEvidenceSummary = report.failureEvidence.summary;
  report.reportLinks = await writeSupplementalCReportPages(outDir, report, targetFunctionFilter, artifacts);
  let diagnosticSummary = summarizeDiagnostics(report.diagnostics);
  report.diagnosticSummary = diagnosticSummary;
  const generatedReports = await writeReportBundle(outDir, report, diagnosticSummary);
  report.artifacts = generatedReports;
  return {
    status: effectiveReportStatus,
    mcpStatus: effectiveReportStatus,
    reusedPreviousRun,
    jobId: status.jobId || args.jobId || null,
    runId: report.runId,
    outDir,
    exitCode: status.exitCode ?? null,
    timedOut: Boolean(status.timedOut),
    coverageExecution,
    sourceTargetFilter: targetFunctionFilter,
    report,
    reportLinks: report.reportLinks,
    diagnostics: report.diagnostics,
    diagnosticSummary,
    blockingDiagnostics: report.diagnostics.filter((item) => item.blocking),
    recommendedActions: report.recommendedActions || [],
    codingAgentResidualRepairPlan,
    codingAgentTestAugmentationPlan,
    actionRequired: primaryActionRequired,
    completionBlocked: Boolean(primaryActionRequired.completionBlocked),
    finalAnswerAllowed: primaryActionRequired.finalAnswerAllowed !== false,
    nextRequiredAction: primaryActionRequired.nextRequiredAction
  };
}

async function validateCFinalEvidence(args = {}) {
  const outDir = path.resolve(args.outDir || workspaceRoot);
  const reportPath = args.reportPath
    ? path.resolve(args.reportPath)
    : path.join(outDir, "mcp_reports", "perfectone_mcp_report.json");
  const report = readJsonWithFallbackSync(reportPath, null);
  if (!report) {
    return {
      status: "blocked",
      code: "mcp_report_missing",
      finalAnswerAllowed: false,
      completionBlocked: true,
      nextRequiredAction: "run_perfectone_c_coverage_before_final_report",
      message: `No MCP report was found at ${reportPath}.`
    };
  }
  const gate = buildCFinalEvidenceGate({ report, outDir });
  const reportDir = path.join(outDir, "mcp_reports");
  await mkdir(reportDir, { recursive: true });
  const gatePath = path.join(reportDir, "final_evidence_gate.json");
  await writeFile(gatePath, JSON.stringify(sanitizeJsonValue(gate), null, 2), "utf8");
  const blockedPath = path.join(reportDir, "FINAL_REPORT_BLOCKED.md");
  const allowedPath = path.join(reportDir, "FINAL_REPORT_ALLOWED.md");
  if (gate.status === "blocked") {
    await writeFile(blockedPath, renderFinalEvidenceGateMarkdown(gate), "utf8");
    if (existsSync(allowedPath)) unlinkSync(allowedPath);
  } else {
    const normalizedReport = applyPassedFinalEvidenceGateToReport(report, gate);
    const diagnosticSummary = summarizeDiagnostics(normalizedReport.diagnostics || []);
    normalizedReport.diagnosticSummary = normalizedReport.diagnosticSummary || diagnosticSummary;
    const reportBaseName = path.basename(reportPath, ".json") || "perfectone_mcp_report";
    await writeReportBundle(outDir, normalizedReport, diagnosticSummary, { reportBaseName });
    if (existsSync(blockedPath)) unlinkSync(blockedPath);
    await writeFile(allowedPath, [
      "# Final Report Allowed",
      "",
      "Coding-agent residual evidence satisfied the final evidence gate.",
      "",
      `- status: ${gate.status}`,
      `- finalAnswerAllowed: ${gate.finalAnswerAllowed}`,
      `- attemptHistoryPath: ${gate.attemptHistoryPath || "none"}`,
      `- attemptCount: ${gate.attemptCount}`,
      `- perFunctionCount: ${gate.perFunctionCount}`,
      `- staleReportStateCorrected: ${gate.staleReportState ? "yes" : "no"}`
    ].join("\n"), "utf8");
  }
  return {
    ...gate,
    gatePath,
    reportPath,
    outDir
  };
}

async function cancelCoverageJob(args) {
  const job = args.jobId ? coverageJobs.get(args.jobId) : null;
  if (!job?.child) {
    return { status: "not_found", jobId: args.jobId || null, message: "No live coverage job process was found in this MCP server session." };
  }
  try {
    job.child.kill();
  } catch (error) {
    return { status: "failed", jobId: args.jobId, error: String(error) };
  }
  const status = {
    ...(readJsonWithFallbackSync(job.paths.statusPath, {}) || {}),
    status: "cancelled",
    completedAt: new Date().toISOString()
  };
  await writeJson(job.paths.statusPath, status).catch(() => {});
  return { status: "cancelled", jobId: args.jobId, statusPath: job.paths.statusPath };
}

async function runFilteredCCoverage({ cliPath, args }) {
  const language = String(args.language || args.request?.language || "c").toLowerCase();
  if (language !== "c") return cPreviewUnsupported(language, { entrypoint: "perfectone_run_filtered_c_coverage" });
  if (args.blocking === true) {
    return runFilteredCCoverageBlocking({ cliPath, args });
  }
  return startFilteredCCoverageJob({ cliPath, args });
}

async function runCUnitVerifyFull({ cliPath, args }) {
  const request = { ...(args.request || {}) };
  if (args.environment && !request.environment) request.environment = args.environment;
  const language = String(args.language || request.language || "c").toLowerCase();
  if (language !== "c") return cPreviewUnsupported(language);
  const projectRoot = path.resolve(request.projectRoot || args.projectRoot || workspaceRoot);
  request.projectRoot = projectRoot;
  const previousRuns = discoverPreviousCRuns(projectRoot, {
    outDir: args.previousRunOutDir || args.outDir || request.outDir,
    maxResults: args.maxPreviousRuns || 10
  });
  const reuseWasSpecified = Object.prototype.hasOwnProperty.call(args, "reusePreviousRun");
  if (previousRuns.found && !reuseWasSpecified) {
    return {
      status: "previous_results_found",
      mcpStatus: "awaiting_previous_run_reuse_decision",
      requiresUserChoice: true,
      defaultAction: "new_run",
      previousRuns,
      nextRequiredAction: "ask_user_reuse_previous_results_or_start_new_run",
      finalAnswerAllowed: false,
      completionBlocked: true,
      message: "Previous PerfectOne C verification results were found. Ask the user whether to reuse them. The default selection is a new run."
    };
  }
  if (args.reusePreviousRun === true) {
    const selectedOutDir = path.resolve(args.previousRunOutDir || args.outDir || previousRuns.runs[0]?.outDir || request.outDir || projectRoot);
    const selected = previousRuns.runs.find((run) => path.resolve(run.outDir) === selectedOutDir) || summarizePreviousCRun(selectedOutDir, projectRoot);
    if (!selected) {
      return {
        status: "failed",
        mcpStatus: "previous_run_not_found",
        previousRuns,
        blockingDiagnostics: [{
          severity: "error",
          code: "previous_run_not_found",
          message: `Requested previous run was not found: ${selectedOutDir}`,
          source: "mcp",
          blocking: true
        }],
        message: "The requested previous PerfectOne C result cannot be reused because no recognized artifacts were found."
      };
    }
    const reused = await collectCoverageJobResult({
      outDir: selected.outDir,
      statusPath: selected.statusPath,
      progressPath: selected.progressPath,
      jobId: selected.jobId,
      reusePreviousRun: true
    });
    return {
      ...reused,
      reusedPreviousRun: true,
      previousRun: selected,
      previousRuns,
      message: "Reused an existing PerfectOne C verification result instead of starting a new run."
    };
  }
  if (previousRuns.found && args.reusePreviousRun === false && !args.outDir && !request.outDir) {
    request.outDir = path.join(".perfectone", `unit-verify-${timestampForPath()}`);
  }
  const unitResult = await callTool("perfectone_run_unit_verification", {
    perfectoneCli: args.perfectoneCli,
    request,
    environment: args.environment,
    timeoutMs: args.unitVerifyTimeoutMs ?? args.timeoutMs
  });
  const artifactGeneration = {
    status: unitResult.status,
    mcpStatus: unitResult.mcpStatus,
    coverageUnmetMeans: unitResult.status === "coverage_unmet" || unitResult.mcpStatus === "needs_c_coverage_execution"
      ? "artifact_generation_complete"
      : unitResult.status,
    nextRequiredAction: "run_filtered_klee_mcdc",
    outDir: unitResult.outDir,
    functionReports: unitResult.report?.functionReports || unitResult.functionReports || []
  };
  const coverageArgs = {
    ...args,
    request: unitResult.report?.unitVerifyRequest || request,
    projectRoot: request.projectRoot,
    outDir: args.outDir || request.outDir || unitResult.outDir,
    ir: args.ir || path.join(unitResult.outDir || resolveRequestOutDir(path.resolve(request.projectRoot || workspaceRoot), request), "ir.json"),
    functionReports: artifactGeneration.functionReports,
    unitVerifyResult: unitResult,
    blocking: args.blocking === true
  };
  const coverage = await runFilteredCCoverage({ cliPath, args: coverageArgs });
  return {
    status: coverage.status === "started" ? "started" : coverage.status,
    mcpStatus: coverage.mcpStatus || coverage.status,
    artifactGeneration,
    coverageJob: coverage.status === "started" ? coverage : null,
    coverageResult: coverage.status === "started" ? null : coverage,
    previousRunPolicy: {
      defaultAction: "new_run",
      reusePreviousRun: false,
      priorResultsFound: previousRuns.found,
      previousRuns
    },
    nextRequiredAction: coverage.status === "started" ? "poll_perfectone_get_coverage_job_status_every_30s" : coverage.nextRequiredAction,
    finalAnswerAllowed: coverage.status === "started" ? false : coverage.finalAnswerAllowed,
    completionBlocked: coverage.status === "started" ? true : coverage.completionBlocked,
    message: coverage.status === "started"
      ? "C full verification has generated artifacts and started filtered KLEE/MC/DC coverage in the background. Poll every 30 seconds and report progress."
      : "C full verification completed the MCP orchestration stage."
  };
}

async function callTool(name, args) {
  if (name === "unitverify_validate_artifact") {
    return validateArtifactTool(args);
  }

  if (name === "unitverify_render_review_html") {
    return renderReviewHtmlTool(args);
  }

  if (name === "unitverify_import_manual_tests") {
    return importManualTestsTool(args);
  }

  if (name === "unitverify_export_manual_tests") {
    return exportManualTestsTool(args);
  }

  if (name === "unitverify_compare_expected_values") {
    return compareExpectedValuesTool(args);
  }

  if (name === "unitverify_build_traceability_report") {
    return buildTraceabilityReportTool(args);
  }

  if (name === "unitverify_extract_design_from_source") {
    const language = String(args.language || "c").toLowerCase();
    if (language !== "c") return cPreviewUnsupported(language, { entrypoint: name });
    return extractDesignFromSourceTool(args);
  }

  if (name === "unitverify_generate_design_from_spec") {
    const language = String(args.language || "c").toLowerCase();
    if (language !== "c") return cPreviewUnsupported(language, { entrypoint: name });
    return generateDesignFromSpecTool(args);
  }

  if (name === "unitverify_detect_toolchain_environment") {
    const language = String(args.language || "c").toLowerCase();
    if (language !== "c" && language !== "unknown") return cPreviewUnsupported(language, { entrypoint: name });
    return detectToolchainEnvironment(args);
  }

  if (name === "unitverify_prepare_windows_local_mcdc") {
    return prepareWindowsLlvmToolchain(args);
  }

  if (name === "perfectone_detect_c_project") {
    return detectCProject(args.projectRoot, args.environment || {}, args);
  }

  if (name === "perfectone_prepare_cli") {
    return preparePerfectOneCli(args);
  }

  if (name === "perfectone_get_coverage_job_status") {
    return getCoverageJobStatus(args);
  }

  if (name === "perfectone_collect_coverage_job_result") {
    return collectCoverageJobResult(args);
  }

  if (name === "perfectone_validate_c_final_evidence") {
    return validateCFinalEvidence(args);
  }

  if (name === "perfectone_cancel_coverage_job") {
    return cancelCoverageJob(args);
  }

  if (name === "perfectone_run_filtered_c_coverage") {
    const cliPath = findPerfectOneCli(args.perfectoneCli, { hostOs: args.environment?.hostOs || args.request?.environment?.hostOs, workspaceRoot: args.workspaceRoot });
    return runFilteredCCoverage({ cliPath, args });
  }

  const cliPath = findPerfectOneCli(args.perfectoneCli, { hostOs: args.environment?.hostOs || args.request?.environment?.hostOs, workspaceRoot: args.workspaceRoot });
  if (!cliPath) {
    return {
      status: "failed",
      reason: "perfectone_cli_not_found",
      searchedFrom: workspaceRoot,
      prepareCli: perfectOneCliDiscovery(args),
      diagnosticSummary: { total: 1, blocking: 1, codes: { perfectone_cli_not_found: 1 } },
      blockingDiagnostics: [
        {
          severity: "error",
          code: "perfectone_cli_not_found",
          message: "PerfectOne CLI was not found. Provide a prebuilt ClangParserForWin.exe/ClangParserForLinux/ClangParserForMac path through perfectoneCli or PERFECTONE_CLI.",
          source: "mcp",
          blocking: true
        }
      ],
      recommendedActions: ["Provision the matching PerfectOne CLI outside the plugin, then set perfectoneCli/PERFECTONE_CLI or place it under bin/<platform> before invoking MCP verification."]
    };
  }

  if (name === "perfectone_capabilities") {
    const result = await runCli(cliPath, ["--capabilities", "--json"], { timeoutMs: args.timeoutMs ?? 15000 });
    return {
      cliPath,
      exitCode: result.code,
      timedOut: Boolean(result.timedOut),
      mcpCapabilities: {
        supportedHostOs: ["windows", "linux", "macos"],
        cliBuildTarget: normalizeHostOs(args.environment?.hostOs),
        nativeKlee: nativeCoverageReady(detectLocalToolchain({ ...(args.environment || {}), language: "c" }), cliPath),
        dockerKlee: Boolean(detectLocalToolchain({ ...(args.environment || {}), language: "c" }).docker?.available),
        mcdc: "requires LLVM coverage with MC/DC support",
        windowsLocalResidualMcdc: detectLocalToolchain({ ...(args.environment || {}), language: "c" }).windowsLocalMcdc || null
      },
      ...parseJsonOutput(result)
    };
  }

  if (name === "perfectone_run_c_unit_verify_full") {
    return runCUnitVerifyFull({ cliPath, args });
  }

  if (name === "perfectone_get_artifact_manifest") {
    const outDir = args.outDir || path.join(workspaceRoot, ".perfectone");
    const result = await runCli(cliPath, ["artifact-manifest", "--outdir", outDir, "--json"], { timeoutMs: args.timeoutMs });
    const manifest = parseJsonOutput(result);
    manifest.artifacts = enrichManifestArtifacts(manifest.artifacts || [], outDir);
    const functionReports = buildFunctionReports({ artifacts: manifest.artifacts || [], functions: [] }, {}, []);
    return { cliPath, exitCode: result.code, timedOut: Boolean(result.timedOut), ...manifest, functionReports };
  }

  if (name === "perfectone_run_unit_verification") {
    const originalRequest = { ...(args.request || {}) };
    if (args.environment && !originalRequest.environment) originalRequest.environment = args.environment;
    const language = String(originalRequest.language || "c").toLowerCase();
    if (language !== "c") return cPreviewUnsupported(language, { entrypoint: name });
    const projectRoot = path.resolve(originalRequest.projectRoot || workspaceRoot);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "perfectone-unit-verify-"));
    const requestPath = path.join(tempDir, "request.json");
    const reportPath = path.join(tempDir, "report.json");
    const { request: compileReadyRequest, context: injectedCompileContext } = await maybeInjectCompileDb(projectRoot, originalRequest, tempDir);
    const { request, context: targetFunctionFilter } = await maybeConstrainAllFunctionsToSource(projectRoot, compileReadyRequest);
    await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");
    const result = await runCli(
      cliPath,
      ["unit-verify", "--request", requestPath, "--output", reportPath, "--json"],
      { cwd: projectRoot, timeoutMs: args.timeoutMs }
    );
    return normalizeUnitVerifyResult({ cliPath, request, projectRoot, tempDir, reportPath, result, injectedCompileContext, targetFunctionFilter });
  }

  if (name === "perfectone_replay") {
    const cliArgs = ["--phase", "replay", "--outdir", args.outDir || "."];
    if (args.ir) cliArgs.push("--ir", args.ir);
    if (args.func) cliArgs.push("--func", args.func);
    if (args.tool) cliArgs.push("--tool", args.tool);
    const result = await runCli(cliPath, cliArgs, { cwd: args.projectRoot || workspaceRoot, timeoutMs: args.timeoutMs });
    const diagnostics = normalizeDiagnostics({
      report: { diagnostics: [], status: result.code === 0 ? "passed" : "failed" },
      stderr: result.stderr,
      stdout: result.stdout,
      logText: "",
      localToolchain: detectLocalToolchain()
    });
    return {
      status: result.code === 0 ? "passed" : "failed",
      cliPath,
      exitCode: result.code,
      timedOut: result.timedOut,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      diagnosticSummary: summarizeDiagnostics(diagnostics),
      blockingDiagnostics: diagnostics.filter((item) => item.blocking)
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

const tools = [
  {
    name: "unitverify_validate_artifact",
    description: "Validate language-independent unit design artifacts such as spec analysis, test design, assertions, oracles, traceability, and review state.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        artifact: { type: "object" },
        artifactPath: { type: "string" },
        artifacts: { type: "array", items: { type: "object" } },
        artifactPaths: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "unitverify_render_review_html",
    description: "Render a standalone HTML review UX for language-independent unit design artifacts, including specified/inferred/missing/needs_review/approved status.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        title: { type: "string" },
        artifact: { type: "object" },
        artifactPath: { type: "string" },
        artifacts: { type: "array", items: { type: "object" } },
        artifactPaths: { type: "array", items: { type: "string" } },
        outFile: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_import_manual_tests",
    description: "Import manual testcases from CSV text or a CSV file into a unitverify.test-design.v1 JSON artifact.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        inputPath: { type: "string" },
        csvText: { type: "string" },
        outFile: { type: "string" },
        designId: { type: "string" },
        language: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_export_manual_tests",
    description: "Export manual testcases from a unitverify.test-design.v1 artifact to CSV for user review or external editing.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        artifact: { type: "object" },
        artifactPath: { type: "string" },
        outFile: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_compare_expected_values",
    description: "Compare oracle expected values with actual execution results and write a structured expected/actual diff report.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        oracleArtifact: { type: "object" },
        oraclePath: { type: "string" },
        actuals: { type: ["array", "object"] },
        actualPath: { type: "string" },
        outFile: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_build_traceability_report",
    description: "Build a standalone HTML traceability matrix linking requirements, design rows, testcases, assertions, oracles, generated code, coverage, and results.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        artifact: { type: "object" },
        artifactPath: { type: "string" },
        artifacts: { type: "array", items: { type: "object" } },
        artifactPaths: { type: "array", items: { type: "string" } },
        outFile: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_generate_design_from_spec",
    description: "Generate language-independent unit design artifacts from a specification: manual testcase seeds, decision tables, state transitions, mandatory boundary values, mandatory equivalence partitions, assertions, oracles, review HTML, and VSCode-template-based Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        specText: { type: "string" },
        specPath: { type: "string" },
        language: { type: "string" },
        targetUnits: { type: "array", items: { type: ["string", "object"] } },
        outDir: { type: "string" }
      }
    }
  },
  {
    name: "unitverify_extract_design_from_source",
    description: "Extract source-derived draft unit design artifacts from source code: signatures, input/output/state candidates, branch conditions, decision table rows, boundary/equivalence candidates, assertions, and oracles.",
    inputSchema: {
      type: "object",
      required: ["sourceFiles"],
      properties: {
        projectRoot: { type: "string" },
        language: { enum: ["c", "cpp", "js", "ts", "rust", "python", "go", "java", "csharp", "ruby", "unknown"] },
        sourceFiles: { type: "array", items: { type: "string" } },
        symbols: { type: "array", items: { type: "string" } },
        outDir: { type: "string" },
        compileArgs: { type: "array", items: { type: "string" } },
        preferCompilerAst: { type: "boolean" },
        includeBranches: { type: "boolean" },
        includeAssertions: { type: "boolean" },
        includeOracles: { type: "boolean" }
      }
    }
  },
  {
    name: "unitverify_detect_toolchain_environment",
    description: "Detect host/target OS, language-native compilers, coverage tools, build metadata, setup prompt, and blocking toolchain diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        language: { type: "string" },
        sourceFiles: { type: "array", items: { type: "string" } },
        environment: { type: "object" }
      }
    }
  },
  {
    name: "unitverify_prepare_windows_local_mcdc",
    description: "Probe or, after explicit user approval, install LLVM for Windows so Coding Agent residual harnesses can measure MC/DC locally with clang and lld-link.",
    inputSchema: {
      type: "object",
      properties: {
        environment: { type: "object" },
        installApproved: { type: "boolean", description: "Set true only after the user explicitly approved installing LLVM for Windows." },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_prepare_cli",
    description: "Discover existing PerfectOne CLI binaries and return external provisioning guidance. This compatibility tool never installs packages or builds binaries.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: { type: "string" },
        perfectoneCli: { type: "string" },
        environment: { type: "object" },
        execute: { type: "boolean" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_capabilities",
    description: "Return PerfectOne CLI machine-readable capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        perfectoneCli: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_detect_c_project",
    description: "Detect C project shape, compile DB, source inventory, and local toolchain availability.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string" },
        environment: { type: "object" },
        sourceFiles: { type: "array", items: { type: "string" } },
        outDir: { type: "string" },
        maxPreviousRuns: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_run_unit_verification",
    description: "Run PerfectOne CLI unit-verify for C artifact generation and return normalized diagnostics, artifacts, source-target filter, and residual coverage actions.",
    inputSchema: {
      type: "object",
      required: ["request"],
      properties: {
        perfectoneCli: { type: "string" },
        request: { type: "object" },
        environment: { type: "object" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_run_c_unit_verify_full",
    description: "C-only orchestration: run PerfectOne artifact generation, then source-target-filtered KLEE/MC/DC coverage as a background job by default, carrying functionReports and residual metadata against the 100% coverage goal.",
    inputSchema: {
      type: "object",
      required: ["request"],
      properties: {
        perfectoneCli: { type: "string" },
        language: { enum: ["c"] },
        projectRoot: { type: "string" },
        request: { type: "object" },
        outDir: { type: "string" },
        ir: { type: "string" },
        runner: { enum: ["auto", "docker", "local", "noop"] },
        runnerPolicy: { enum: ["os-default", "native-first", "docker-first"] },
        environment: { type: "object" },
        executionProfile: { enum: ["quick", "full", "setup"] },
        replayMaxCasesPerFunction: { type: "number" },
        replayDedup: { enum: ["coverage-signature", "input-hash", "none"] },
        nativeReplayTimeout: { type: "number" },
        coverageGoal: { type: "object" },
        coverageOptions: { type: "object", additionalProperties: true },
        unitDesignArtifacts: { type: ["object", "array"] },
        reusePreviousRun: { type: "boolean", description: "When true, reuse a selected previous C result. When false, start a new run. When omitted and previous results exist, MCP returns previous_results_found so the skill can ask the user first." },
        previousRunOutDir: { type: "string" },
        maxPreviousRuns: { type: "number" },
        blocking: { type: "boolean", description: "When true, block until coverage completes. Default is background job mode with 30s polling." },
        timeoutMs: { type: "number", description: "Host/MCP call timeout hint. C coverage child process timeout is clamped to at least 30 minutes." },
        coverageTimeoutMs: { type: "number", description: "Optional C coverage child process timeout. Values below 30 minutes are clamped to 30 minutes." },
        unitVerifyTimeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_run_filtered_c_coverage",
    description: "Run C-only source-target-filtered PerfectOne KLEE/coverage/MCDC using Docker by default after unit-verify artifact generation. WSL is disabled. Default mode starts a background job and returns job metadata for 30s polling.",
    inputSchema: {
      type: "object",
      properties: {
        perfectoneCli: { type: "string" },
        projectRoot: { type: "string" },
        request: { type: "object" },
        sourceFiles: { type: "array", items: { type: "string" } },
        outDir: { type: "string" },
        ir: { type: "string" },
        runner: { enum: ["auto", "docker", "local", "noop"] },
        runnerPolicy: { enum: ["os-default", "native-first", "docker-first"] },
        environment: { type: "object" },
        executionProfile: { enum: ["quick", "full", "setup"] },
        replayMaxCasesPerFunction: { type: "number" },
        replayDedup: { enum: ["coverage-signature", "input-hash", "none"] },
        nativeReplayTimeout: { type: "number" },
        timeoutMs: { type: "number", description: "Host/MCP call timeout hint. C coverage child process timeout is clamped to at least 30 minutes." },
        coverageTimeoutMs: { type: "number", description: "Optional C coverage child process timeout. Values below 30 minutes are clamped to 30 minutes." },
        blocking: { type: "boolean", description: "When true, keep the legacy blocking call behavior. Default starts a background job." },
        functionReports: { type: "array", items: { type: "object" } },
        unitVerifyResult: { type: "object" },
        coverageOptions: {
          type: "object",
          description: "Coding-agent-selected C exploration and coverage options. MCP does not recommend these from source; it only applies explicit values and clamps structDepth to security max 5.",
          properties: {
            kleeMaxTime: { type: "number" },
            kleeMaxMemory: { type: "number" },
            kleeParallel: { type: "number" },
            kleeTestParallel: { type: "number" },
            executionProfile: { enum: ["quick", "full", "setup"] },
            replayMaxCasesPerFunction: { type: "number" },
            replayDedup: { enum: ["coverage-signature", "input-hash", "none"] },
            nativeReplayTimeout: { type: "number" },
            clang: { type: "string" },
            llvmCov: { type: "string" },
            llvmProfdata: { type: "string" },
            llvm2lcov: { type: "string" },
            lcov: { type: "string" },
            genhtml: { type: "string" },
            heterogeneous: { type: "boolean" },
            hetero: { type: ["boolean", "string"] },
            structDepth: { type: "number" },
            pointerArraySize: { type: "number" },
            arrayMaxDims: { type: "number" },
            famSize: { type: "number" }
          },
          additionalProperties: true
        }
      }
    }
  },
  {
    name: "perfectone_get_coverage_job_status",
    description: "Poll a background C coverage job. Skills should call this every 30 seconds and report phase/function/KLEE/native/merge/profraw/crash progress to the user.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        outDir: { type: "string" },
        statusPath: { type: "string" },
        progressPath: { type: "string" }
      }
    }
  },
  {
    name: "perfectone_collect_coverage_job_result",
    description: "Collect, normalize, and render the final report for a completed background C coverage job. If the job is still running, returns running status.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        outDir: { type: "string" },
        statusPath: { type: "string" },
        progressPath: { type: "string" },
        sourceTargetFilter: { type: "object" },
        functionReports: { type: "array", items: { type: "object" } }
      }
    }
  },
  {
    name: "perfectone_validate_c_final_evidence",
    description: "Validate that C final reporting is allowed. Blocks final answers when MCP residual repair is still required, attempt history is missing, or the 100% coverage goal lacks residual evidence.",
    inputSchema: {
      type: "object",
      required: ["outDir"],
      properties: {
        outDir: { type: "string" },
        reportPath: { type: "string" }
      }
    }
  },
  {
    name: "perfectone_cancel_coverage_job",
    description: "Cancel a live background C coverage job started by this MCP server session.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" }
      }
    }
  },
  {
    name: "perfectone_get_artifact_manifest",
    description: "Return a manifest of PerfectOne artifacts under an output directory, enriched with function report hints.",
    inputSchema: {
      type: "object",
      properties: {
        perfectoneCli: { type: "string" },
        outDir: { type: "string" },
        timeoutMs: { type: "number" }
      }
    }
  },
  {
    name: "perfectone_replay",
    description: "Run the existing PerfectOne replay phase for generated artifacts and normalize replay diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        perfectoneCli: { type: "string" },
        projectRoot: { type: "string" },
        outDir: { type: "string" },
        ir: { type: "string" },
        func: { type: "string" },
        tool: { enum: ["auto", "klee", "cbmc", "libfuzzer"] },
        timeoutMs: { type: "number" }
      }
    }
  }
];

async function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "perfectone-unit-verify", version: "0.2.0-beta.8" }
      }
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    return;
  }
  if (message.method === "tools/call") {
    try {
      const result = await callTool(message.params.name, message.params.arguments || {});
      toolResult(message.id, result, Boolean(result && result.status === "failed"));
    } catch (error) {
      toolResult(message.id, { status: "failed", error: String(error) }, true);
    }
    return;
  }
  if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === "prompts/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { prompts: [] } });
    return;
  }
  if (message.id !== undefined) protocolError(message.id, -32601, `Unknown method: ${message.method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    await handle(JSON.parse(line));
  } catch (error) {
    protocolError(null, -32700, String(error));
  }
});
