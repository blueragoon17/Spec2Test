#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-targets-required-"));
const reportDir = path.join(outDir, "mcp_reports");
const residualDir = path.join(outDir, "residual");
mkdirSync(reportDir, { recursive: true });
mkdirSync(residualDir, { recursive: true });

function validate() {
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
      nextRequiredAction: "execute_coding_agent_residual_repair_loop"
    },
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    }
  }, null, 2));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    writeFileSync(path.join(residualDir, `residual_attempt${attempt}_llvm.json`), JSON.stringify({ attempt }));
  }

  const result = validate();
  if (!result) throw new Error("missing validation result");
  if (result.status !== "blocked") throw new Error(`expected empty target list to block, got ${JSON.stringify(result)}`);
  if (!result.blockers?.includes("residual_targets_missing")) {
    throw new Error(`missing residual_targets_missing blocker: ${JSON.stringify(result)}`);
  }
  if (result.finalAnswerAllowed !== false || result.completionBlocked !== true) {
    throw new Error(`empty target list must not allow final answer: ${JSON.stringify(result)}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    gateStatus: result.status,
    blockers: result.blockers
  }, null, 2));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

const summaryOnlyOutDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-summary-only-"));
const summaryOnlyReportDir = path.join(summaryOnlyOutDir, "mcp_reports");
mkdirSync(summaryOnlyReportDir, { recursive: true });

try {
  writeFileSync(path.join(summaryOnlyReportDir, "perfectone_mcp_report.json"), JSON.stringify({
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
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [
        { function: "func1" },
        { function: "func2" }
      ],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    }
  }, null, 2));
  writeFileSync(path.join(summaryOnlyReportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
    "- `func1`: crash-risk. Classified without retry artifacts.",
    "- `func2`: infeasible. Classified without retry artifacts."
  ].join("\n"));

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "perfectone_validate_c_final_evidence",
        arguments: { outDir: summaryOnlyOutDir }
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
  const summaryOnlyResult = lines.find((line) => line.id === 2)?.result?.structuredContent;
  if (!summaryOnlyResult) throw new Error("missing summary-only validation result");
  if (summaryOnlyResult.status !== "blocked") throw new Error(`summary-only residual classification must block, got ${JSON.stringify(summaryOnlyResult)}`);
  if (!summaryOnlyResult.blockers?.includes("coverage_growth_attempts_missing")) {
    throw new Error(`missing aggregate retry blocker for summary-only classification: ${JSON.stringify(summaryOnlyResult)}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    summaryOnlyGateStatus: summaryOnlyResult.status,
    summaryOnlyBlockers: summaryOnlyResult.blockers
  }, null, 2));
} finally {
  rmSync(summaryOnlyOutDir, { recursive: true, force: true });
}

const aliasTargetsOutDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-alias-targets-"));
const aliasTargetsReportDir = path.join(aliasTargetsOutDir, "mcp_reports");
const aliasTargetsResidualDir = path.join(aliasTargetsOutDir, "residual");
mkdirSync(aliasTargetsReportDir, { recursive: true });
mkdirSync(aliasTargetsResidualDir, { recursive: true });

try {
  writeFileSync(path.join(aliasTargetsReportDir, "perfectone_mcp_report.json"), JSON.stringify({
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
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [
        "func1",
        { targetFunction: "func2" }
      ],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    }
  }, null, 2));
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    writeFileSync(path.join(aliasTargetsResidualDir, `residual_attempt${attempt}.c`), `/* generated attempt ${attempt} */\n`);
    const pct = attempt <= 3 ? 80 + attempt : 83;
    writeFileSync(path.join(aliasTargetsResidualDir, `residual_attempt${attempt}_llvm.json`), JSON.stringify({
      attempt,
      afterCoverage: { line: pct, branch: pct - 10, function: 90, mcdc: 40 }
    }));
  }
  writeFileSync(path.join(aliasTargetsReportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
    "- `func1`: crash-risk. Classified after aggregate attempts.",
    "- `func2`: infeasible. Classified after aggregate attempts."
  ].join("\n"));

  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "perfectone_validate_c_final_evidence",
        arguments: { outDir: aliasTargetsOutDir }
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
  const aliasTargetsResult = lines.find((line) => line.id === 2)?.result?.structuredContent;
  if (!aliasTargetsResult) throw new Error("missing alias-target validation result");
  if (aliasTargetsResult.status !== "passed" || aliasTargetsResult.coveragePlateauSatisfied !== true) {
    throw new Error(`string/targetFunction targets should be recognized and satisfied: ${JSON.stringify(aliasTargetsResult)}`);
  }
  console.log(JSON.stringify({
    status: "passed",
    aliasTargetsGateStatus: aliasTargetsResult.status,
    requiredTargets: aliasTargetsResult.requiredTargets
  }, null, 2));
} finally {
  rmSync(aliasTargetsOutDir, { recursive: true, force: true });
}
