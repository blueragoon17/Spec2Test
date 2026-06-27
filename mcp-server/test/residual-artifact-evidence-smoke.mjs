#!/usr/bin/env node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-artifact-gate-"));
const reportDir = path.join(outDir, "mcp_reports");
const residualDir = path.join(outDir, "residual");
mkdirSync(reportDir, { recursive: true });
mkdirSync(residualDir, { recursive: true });

function runValidate() {
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
  if (completed.status !== 0) throw new Error(`server exited ${completed.status}: ${completed.stderr}`);
  const lines = completed.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  return lines.find((line) => line.id === 2)?.result?.structuredContent;
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
      nextRequiredAction: "execute_coding_agent_residual_repair_loop"
    },
    codingAgentResidualActionRequired: {
      required: true,
      completionBlocked: true,
      finalAnswerAllowed: false,
      nextRequiredAction: "execute_coding_agent_residual_repair_loop",
      message: "Coding-agent residual repair is mandatory before the final answer."
    },
    codingAgentTestAugmentationActionRequired: {
      required: true,
      completionBlocked: true,
      finalAnswerAllowed: false,
      nextRequiredAction: "execute_coding_agent_test_augmentation",
      message: "Coding Agent test augmentation is required before the final answer."
    },
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [
        { function: "target_func", unmetMetrics: ["branch"] },
        { function: "TD_main_0_0", unmetMetrics: ["function"] }
      ],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    },
    codingPlatformPrompt: "Coding Agent residual repair is mandatory before the final answer.",
    codingAgentResidualRepairPrompt: "Coding-agent residual repair is mandatory before the final answer.",
    codingAgentTestAugmentationPrompt: "Coding Agent test augmentation is required before the final answer."
  }, null, 2));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    writeFileSync(path.join(residualDir, `residual_attempt${attempt}.c`), `/* generated attempt ${attempt} */\n`);
    writeFileSync(path.join(residualDir, `residual_attempt${attempt}_report.txt`), `attempt ${attempt} report\n`);
    writeFileSync(path.join(residualDir, `residual_attempt${attempt}_llvm.json`), JSON.stringify({ attempt }));
  }
  writeFileSync(path.join(residualDir, "tdmain_probe.profraw"), "");
  writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
    "# Residual Summary",
    "",
    "## Remaining Gaps",
    "",
    "- `target_func`: max-attempts-reached-with-classified-gaps; remaining branch is max-coverage after aggregate attempts.",
    "- `TD_main_0_0`: crash-risk. Direct probe exits with Windows access violation."
  ].join("\n"));

  const result = runValidate();
  if (!result) throw new Error("missing validation result");
  if (result.status !== "passed") throw new Error(`expected passed from discovered artifacts, got ${JSON.stringify(result)}`);
  if (result.attemptHistoryPath !== "discovered-residual-artifacts") {
    throw new Error(`expected discovered artifact evidence, got ${result.attemptHistoryPath}`);
  }
  if (result.aggregateEvidenceSatisfied !== true) {
    throw new Error(`aggregate residual evidence was not accepted: ${JSON.stringify(result)}`);
  }
  if (result.missingTargets?.length) {
    throw new Error(`aggregate evidence should satisfy target coverage history without per-function duplication: ${JSON.stringify(result.missingTargets)}`);
  }
  const rewritten = JSON.parse(readFileSync(path.join(reportDir, "perfectone_mcp_report.json"), "utf8"));
  if (rewritten.finalAnswerAllowed !== true || rewritten.completionBlocked !== false) {
    throw new Error("canonical report was not normalized from discovered residual artifacts");
  }
  if ("codingPlatformPrompt" in rewritten || "codingAgentResidualRepairPrompt" in rewritten || "codingAgentTestAugmentationPrompt" in rewritten) {
    throw new Error("stale final-blocking prompts were not removed");
  }
  const html = readFileSync(path.join(reportDir, "perfectone_mcp_report.html"), "utf8");
  if (!html.includes("Final answer allowed:</strong> yes") || html.includes("Final answer allowed:</strong> no")) {
    throw new Error("HTML report does not reflect the discovered-artifact final gate state");
  }
  if (!existsSync(path.join(reportDir, "FINAL_REPORT_ALLOWED.md"))) {
    throw new Error("allowed marker was not written");
  }
  console.log(JSON.stringify({
    status: "passed",
    aggregateEvidenceSatisfied: result.aggregateEvidenceSatisfied,
    attemptCount: result.attemptCount,
    classifiedRemainingGapCount: result.classifiedRemainingGapCount,
    finalAnswerAllowed: result.finalAnswerAllowed
  }, null, 2));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
