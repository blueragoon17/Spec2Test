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
if (belowPlanMax.status !== "blocked" || !belowPlanMax.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function attempts below plan max should block: ${JSON.stringify(belowPlanMax)}`);
}

const atPlanMaxNoEvidence = validate(3, 3);
if (atPlanMaxNoEvidence.status !== "blocked" || !atPlanMaxNoEvidence.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function attempts at plan max without evidence should block: ${JSON.stringify(atPlanMaxNoEvidence)}`);
}

const stopReasonOnly = validate(3, 0, false, [{ function: "func1", stopReason: "crash-risk" }]);
if (stopReasonOnly.status !== "blocked" || !stopReasonOnly.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function stopReason without artifact evidence should block: ${JSON.stringify(stopReasonOnly)}`);
}

const stopReasonReportOnly = validate(3, 1, true, [{
  function: "func1",
  stopReason: "crash-risk",
  reportPath: "residual_attempt1_report.txt"
}]);
if (stopReasonReportOnly.status !== "blocked" || !stopReasonReportOnly.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function stopReason with report-only evidence should block: ${JSON.stringify(stopReasonReportOnly)}`);
}

const stopReasonWithLog = validate(3, 1, true, [{
  function: "func1",
  stopReason: "crash-risk",
  logPath: "residual_attempt1.log"
}]);
if (stopReasonWithLog.status !== "blocked" || !stopReasonWithLog.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function stopReason with diagnostic log evidence must still need coverage plateau: ${JSON.stringify(stopReasonWithLog)}`);
}

const legacyStopReasonWithEvidencePath = validate(3, 1, true, null, {
  schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
  perFunctionStopReasons: [{
    function: "func1",
    evidencePath: "residual_attempt1.log",
    stopReason: "crash-risk"
  }]
});
if (legacyStopReasonWithEvidencePath.status !== "blocked" || !legacyStopReasonWithEvidencePath.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`legacy perFunctionStopReasons evidencePath alone should not bypass plateau: ${JSON.stringify(legacyStopReasonWithEvidencePath)}`);
}

const goalReachedOnly = validate(3, 0, false, [{ function: "func1", goalReached: true }]);
if (goalReachedOnly.status !== "blocked" || !goalReachedOnly.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function goalReached without artifact evidence should block: ${JSON.stringify(goalReachedOnly)}`);
}

const atPlanMax = validate(3, 3, true);
if (atPlanMax.status !== "blocked" || !atPlanMax.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`per-function attempts at plan max without aggregate coverage plateau should block: ${JSON.stringify(atPlanMax)}`);
}

const plateauAggregate = validate(3, 4, true, null, {
  schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
  aggregateAttempts: [
    { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: 80, branch: 70, function: 90, mcdc: 40 } },
    { attempt: 2, changedArtifact: "residual_attempt2.c", reportPath: "residual_attempt2_report.txt", afterCoverage: { line: 85, branch: 75, function: 90, mcdc: 40 } },
    { attempt: 3, changedArtifact: "residual_attempt3.c", reportPath: "residual_attempt3_report.txt", afterCoverage: { line: 85, branch: 75, function: 90, mcdc: 40 } },
    { attempt: 4, changedArtifact: "residual_attempt4.c", reportPath: "residual_attempt4_report.txt", afterCoverage: { line: 85, branch: 75, function: 90, mcdc: 40 } }
  ],
  perFunctionStopReasons: [{
    function: "func1",
    evidencePath: "residual_attempt1.log",
    stopReason: "max-coverage"
  }]
});
if (plateauAggregate.status !== "passed" || plateauAggregate.coveragePlateauSatisfied !== true) {
  throw new Error(`aggregate two-attempt plateau should pass final gate: ${JSON.stringify(plateauAggregate)}`);
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
  atPlanMaxGateStatus: atPlanMax.status,
  plateauAggregateGateStatus: plateauAggregate.status
}, null, 2));
