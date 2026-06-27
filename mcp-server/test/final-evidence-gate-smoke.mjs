#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-final-gate-"));
const reportDir = path.join(outDir, "mcp_reports");
const residualDir = path.join(outDir, "residual");
mkdirSync(reportDir, { recursive: true });
mkdirSync(residualDir, { recursive: true });

function runValidate(id = 2) {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id,
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
  const call = lines.find((line) => line.id === id);
  const result = call?.result?.structuredContent;
  if (!result) throw new Error("missing structuredContent");
  return result;
}

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
    codingAgentResidualActionRequired: {
      required: true,
      completionBlocked: true,
      finalAnswerAllowed: false,
      nextRequiredAction: "execute_coding_agent_residual_repair_loop",
      targetCount: 1,
      message: "Coding-agent residual repair is mandatory before the final answer. 1 source-target functions remain below goal.",
      requiredEvidence: ["changed generated harness", "before coverage", "after coverage"]
    },
    codingAgentTestAugmentationActionRequired: {
      required: true,
      completionBlocked: true,
      finalAnswerAllowed: false,
      nextRequiredAction: "execute_coding_agent_test_augmentation",
      message: "Coding Agent test augmentation is required before the final answer.",
      requiredEvidence: ["boundary value", "equivalence partition"]
    },
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [{ function: "target_func", unmetMetrics: ["line"] }],
      attemptAccounting: { maxAttemptsPerFunction: 5 },
      attemptHistory: "embedded-report"
    },
    codingPlatformPrompt: "Coding Agent residual repair is mandatory before the final answer.",
    codingAgentResidualRepairPrompt: "Coding-agent residual repair is mandatory before the final answer.",
    codingAgentTestAugmentationPrompt: "Coding Agent test augmentation is required before the final answer.",
    toolchainEnvironment: {
      environment: {
        hostOS: "windows",
        hostOs: "windows"
      }
    }
  }, null, 2));

  const result = runValidate(2);
  if (result.status !== "blocked") throw new Error(`expected blocked, got ${result.status}`);
  if (!result.blockers?.includes("missing_residual_attempt_history")) {
    throw new Error(`missing expected blocker: ${JSON.stringify(result.blockers)}`);
  }

  const blockedPath = path.join(reportDir, "FINAL_REPORT_BLOCKED.md");
  if (!existsSync(blockedPath)) throw new Error("expected blocked marker to exist");

  const historyJson = JSON.stringify({
    schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
    bestCodingAgentCoverage: { line: { pct: 95 }, branch: { pct: 90 } },
    aggregateAttempts: [
      {
        function: "target_func",
        attempt: 1,
        changedArtifact: "residual_attempt1.c",
        beforeCoverage: { line: 75 },
        afterCoverage: { line: 95 },
        delta: { line: 20 }
      }
    ],
    perFunctionAttempts: [
      {
        function: "target_func",
        attempts: [{ attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt" }],
        stopReason: "max-coverage: remaining branch requires infeasible state"
      }
    ]
  }, null, 2);
  writeFileSync(path.join(residualDir, "residual_attempt1.c"), "/* generated residual attempt */\n");
  writeFileSync(path.join(residualDir, "residual_attempt1_report.txt"), "residual coverage report\n");
  writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(historyJson, "utf8")
  ]));

  const passed = runValidate(3);
  if (passed.status !== "passed") throw new Error(`expected passed, got ${passed.status}: ${JSON.stringify(passed)}`);
  if (passed.perFunctionCount < 1 || passed.hasPerFunctionEvidence !== true) {
    throw new Error(`perFunctionAttempts was not recognized: ${JSON.stringify(passed)}`);
  }
  if (existsSync(blockedPath)) throw new Error("stale FINAL_REPORT_BLOCKED.md was not removed");
  if (!existsSync(path.join(reportDir, "FINAL_REPORT_ALLOWED.md"))) throw new Error("expected FINAL_REPORT_ALLOWED.md");
  const rewritten = JSON.parse(readFileSync(path.join(reportDir, "perfectone_mcp_report.json"), "utf8"));
  if (rewritten.finalAnswerAllowed !== true || rewritten.completionBlocked !== false) {
    throw new Error("canonical report was not normalized after passing final gate");
  }
  if (rewritten.codingAgentResidualActionRequired?.required !== false) {
    throw new Error("residual action was not cleared after passing final gate");
  }
  if (String(rewritten.codingAgentResidualActionRequired?.message || "").includes("mandatory before the final answer")) {
    throw new Error("stale residual action message was not cleared");
  }
  if (rewritten.codingAgentTestAugmentationActionRequired?.required !== false) {
    throw new Error("test augmentation action was not cleared after passing final gate");
  }
  if (String(rewritten.codingAgentTestAugmentationActionRequired?.message || "").includes("Coding Agent test augmentation is required before the final answer")) {
    throw new Error("stale test augmentation action message was not cleared");
  }
  if (JSON.stringify(rewritten).includes("hostOS")) {
    throw new Error("legacy hostOS key was not sanitized from rewritten report");
  }
  if ("codingPlatformPrompt" in rewritten || "codingAgentResidualRepairPrompt" in rewritten || "codingAgentTestAugmentationPrompt" in rewritten) {
    throw new Error("stale final-blocking prompt fields were not removed after passing final gate");
  }
  const html = readFileSync(path.join(reportDir, "perfectone_mcp_report.html"), "utf8");
  if (!html.includes("Final answer allowed:</strong> yes")) {
    throw new Error("HTML report was not regenerated after passing final gate");
  }
  if (html.includes("Final answer allowed:</strong> no")) {
    throw new Error("HTML report still contains stale final-answer blocked state");
  }
  const md = readFileSync(path.join(reportDir, "perfectone_mcp_report.md"), "utf8");
  if (!md.includes("- final answer allowed: yes")) {
    throw new Error("Markdown report was not regenerated after passing final gate");
  }
  console.log(JSON.stringify({
    status: "passed",
    blockedGateStatus: result.status,
    passedGateStatus: passed.status,
    blockers: result.blockers,
    finalAnswerAllowed: passed.finalAnswerAllowed
  }, null, 2));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
