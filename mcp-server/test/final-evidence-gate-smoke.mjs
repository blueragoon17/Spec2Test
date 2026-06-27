#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-final-gate-"));
const reportDir = path.join(outDir, "mcp_reports");
mkdirSync(reportDir, { recursive: true });

try {
  writeFileSync(path.join(reportDir, "perfectone_mcp_report.json"), JSON.stringify({
    schemaVersion: "perfectone.unitverify.c.coverage.report.v1",
    status: "needs_coding_agent_residual",
    completionBlocked: true,
    finalAnswerAllowed: false,
    actionRequired: {
      required: true,
      completionBlocked: true,
      finalAnswerAllowed: false,
      nextRequiredAction: "execute_coding_agent_residual_repair_loop",
      targetCount: 1,
      maxAttemptsPerFunction: 5,
      requiredEvidence: ["changed generated harness", "before coverage", "after coverage"]
    },
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [{ function: "target_func", unmetMetrics: ["line"] }],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    },
    toolchainEnvironment: {
      environment: {
        hostOS: "windows",
        hostOs: "windows"
      }
    }
  }, null, 2));

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "perfectone_validate_c_final_evidence",
        arguments: { outDir }
      }
    }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";

  const completed = spawnSync(process.execPath, [path.join(root, "mcp-server", "src", "server.js")], {
    input: messages,
    encoding: "utf8",
    cwd: root,
    timeout: 15000
  });
  if (completed.status !== 0) {
    throw new Error(`server exited ${completed.status}: ${completed.stderr}`);
  }
  const lines = completed.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const call = lines.find((line) => line.id === 2);
  const result = call?.result?.structuredContent;
  if (!result) throw new Error("missing structuredContent");
  if (result.status !== "blocked") throw new Error(`expected blocked, got ${result.status}`);
  if (!result.blockers?.includes("missing_residual_attempt_history")) {
    throw new Error(`missing expected blocker: ${JSON.stringify(result.blockers)}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    gateStatus: result.status,
    blockers: result.blockers,
    finalAnswerAllowed: result.finalAnswerAllowed
  }, null, 2));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
