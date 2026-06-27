#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const projectRoot = mkdtempSync(path.join(os.tmpdir(), "perfectone-full-tool-"));
const sourceFile = path.join(projectRoot, "sample.c");
writeFileSync(sourceFile, "int add(int a, int b) { return a + b; }\n", "utf8");

try {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "perfectone_run_c_unit_verify_full",
        arguments: {
          reusePreviousRun: false,
          blocking: false,
          request: {
            schemaVersion: "perfectone.unitverify.v1",
            projectRoot,
            language: "c",
            sourceFiles: [sourceFile],
            outDir: path.join(projectRoot, ".perfectone", "run"),
            coverageGoal: { line: 100, branch: 100, function: 100, mcdc: 100 },
            strategy: ["klee", "native"]
          }
        }
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";

  const completed = spawnSync(process.execPath, [path.join(root, "mcp-server", "src", "server.js")], {
    input: messages,
    encoding: "utf8",
    cwd: root,
    timeout: 20000
  });
  if (completed.status !== 0) {
    throw new Error(`server exited ${completed.status}: ${completed.stderr}`);
  }
  const lines = completed.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const call = lines.find((line) => line.id === 2);
  const payload = call?.result?.structuredContent || call?.error || {};
  const serialized = JSON.stringify(payload);
  if (serialized.includes("executionMode is not defined") || serialized.includes("dockerPreparationBefore is not defined")) {
    throw new Error(`full orchestration leaked an internal ReferenceError: ${serialized}`);
  }
  if (!payload.status) {
    throw new Error(`full orchestration returned no structured status: ${serialized}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    toolStatus: payload.status,
    mcpStatus: payload.mcpStatus || null,
    referenceError: false
  }, null, 2));
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}
