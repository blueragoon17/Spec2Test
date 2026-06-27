#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function validate(maxAttempts, perFunctionAttempts, withEvidence = false, perFunctionOverride = null, historyOverride = null) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-perfunction-max-"));
  const reportDir = path.join(outDir, "mcp_reports");
  const residualDir = path.join(outDir, "residual");
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(residualDir, { recursive: true });
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
      codingAgentResidualRepairPlan: {
        executionRequired: true,
        targets: [{ function: "func1" }],
        attemptAccounting: { maxAttemptsPerFunction: maxAttempts }
      }
    }, null, 2));
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify(historyOverride || {
      schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
      perFunction: perFunctionOverride || [
        {
          function: "func1",
          attempts: Array.from({ length: perFunctionAttempts }, (_, index) => ({
            attempt: index + 1,
            ...(withEvidence ? {
              changedArtifact: `residual_attempt${index + 1}.c`,
              reportPath: `residual_attempt${index + 1}_report.txt`,
              afterCoverage: { line: 80 + index }
            } : {})
          }))
        }
      ]
    }, null, 2));
    if (withEvidence) {
      for (let attempt = 1; attempt <= perFunctionAttempts; attempt += 1) {
        writeFileSync(path.join(residualDir, `residual_attempt${attempt}.c`), `/* generated attempt ${attempt} */\n`);
        writeFileSync(path.join(residualDir, `residual_attempt${attempt}_report.txt`), `attempt ${attempt} coverage report\n`);
        writeFileSync(path.join(residualDir, `residual_attempt${attempt}.log`), `attempt ${attempt} diagnostic log\n`);
      }
    }
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
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const belowPlanMax = validate(3, 2);
if (belowPlanMax.status !== "blocked" || !belowPlanMax.blockers?.includes("residual_targets_without_max_attempt_or_stop_reason")) {
  throw new Error(`per-function attempts below plan max should block: ${JSON.stringify(belowPlanMax)}`);
}

const atPlanMaxNoEvidence = validate(3, 3);
if (atPlanMaxNoEvidence.status !== "blocked" || !atPlanMaxNoEvidence.blockers?.includes("residual_targets_without_max_attempt_or_stop_reason")) {
  throw new Error(`per-function attempts at plan max without evidence should block: ${JSON.stringify(atPlanMaxNoEvidence)}`);
}

const stopReasonOnly = validate(3, 0, false, [{ function: "func1", stopReason: "crash-risk" }]);
if (stopReasonOnly.status !== "blocked" || !stopReasonOnly.blockers?.includes("residual_targets_without_max_attempt_or_stop_reason")) {
  throw new Error(`per-function stopReason without artifact evidence should block: ${JSON.stringify(stopReasonOnly)}`);
}

const stopReasonReportOnly = validate(3, 1, true, [{
  function: "func1",
  stopReason: "crash-risk",
  reportPath: "residual_attempt1_report.txt"
}]);
if (stopReasonReportOnly.status !== "blocked" || !stopReasonReportOnly.blockers?.includes("residual_targets_without_max_attempt_or_stop_reason")) {
  throw new Error(`per-function stopReason with report-only evidence should block: ${JSON.stringify(stopReasonReportOnly)}`);
}

const stopReasonWithLog = validate(3, 1, true, [{
  function: "func1",
  stopReason: "crash-risk",
  logPath: "residual_attempt1.log"
}]);
if (stopReasonWithLog.status !== "passed") {
  throw new Error(`per-function stopReason with diagnostic log evidence should pass: ${JSON.stringify(stopReasonWithLog)}`);
}

const legacyStopReasonWithEvidencePath = validate(3, 1, true, null, {
  schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
  perFunctionStopReasons: [{
    function: "func1",
    evidencePath: "residual_attempt1.log",
    stopReason: "crash-risk"
  }]
});
if (legacyStopReasonWithEvidencePath.status !== "passed") {
  throw new Error(`legacy perFunctionStopReasons evidencePath should be preserved: ${JSON.stringify(legacyStopReasonWithEvidencePath)}`);
}

const goalReachedOnly = validate(3, 0, false, [{ function: "func1", goalReached: true }]);
if (goalReachedOnly.status !== "blocked" || !goalReachedOnly.blockers?.includes("residual_targets_without_max_attempt_or_stop_reason")) {
  throw new Error(`per-function goalReached without artifact evidence should block: ${JSON.stringify(goalReachedOnly)}`);
}

const atPlanMax = validate(3, 3, true);
if (atPlanMax.status !== "passed") {
  throw new Error(`per-function attempts at plan max should pass: ${JSON.stringify(atPlanMax)}`);
}

console.log(JSON.stringify({
  status: "passed",
  belowPlanMaxGateStatus: belowPlanMax.status,
  atPlanMaxNoEvidenceGateStatus: atPlanMaxNoEvidence.status,
  stopReasonOnlyGateStatus: stopReasonOnly.status,
  stopReasonReportOnlyGateStatus: stopReasonReportOnly.status,
  stopReasonWithLogGateStatus: stopReasonWithLog.status,
  legacyStopReasonWithEvidencePathGateStatus: legacyStopReasonWithEvidencePath.status,
  goalReachedOnlyGateStatus: goalReachedOnly.status,
  atPlanMaxGateStatus: atPlanMax.status
}, null, 2));
