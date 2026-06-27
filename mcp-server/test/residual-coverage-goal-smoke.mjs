#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function validateCoverage(finalCoverage, residualAttempts = [], historyPatch = {}) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-coverage-goal-"));
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
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({
      schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
      finalCoverage,
      residualAttempts,
      ...historyPatch
    }, null, 2));
    for (const attempt of residualAttempts) {
      for (const candidate of [attempt.changedArtifact, attempt.reportPath, attempt.logPath, attempt.coverageArtifact, attempt.measurementArtifact]) {
        if (candidate && typeof candidate === "string" && candidate !== "." && !candidate.includes("does-not-exist") && !candidate.includes("..") && !path.isAbsolute(candidate)) {
          writeFileSync(path.join(residualDir, candidate), `evidence for ${candidate}\n`);
        }
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

function validateCoverageWithPrewrittenArtifacts(finalCoverage, residualAttempts, prewrite) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-coverage-url-"));
  const reportDir = path.join(outDir, "mcp_reports");
  const residualDir = path.join(outDir, "residual");
  mkdirSync(reportDir, { recursive: true });
  mkdirSync(residualDir, { recursive: true });
  try {
    const preparedAttempts = prewrite({ outDir, reportDir, residualDir, residualAttempts });
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
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({
      schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
      finalCoverage,
      residualAttempts: preparedAttempts
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
    if (completed.status !== 0) throw new Error(`server exited ${completed.status}: ${completed.stderr}`);
    const lines = completed.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return lines.find((line) => line.id === 2)?.result?.structuredContent;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function validateReportCoverageOnly(reportCoverage) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-report-coverage-only-"));
  const reportDir = path.join(outDir, "mcp_reports");
  mkdirSync(reportDir, { recursive: true });
  try {
    writeFileSync(path.join(reportDir, "perfectone_mcp_report.json"), JSON.stringify({
      schemaVersion: "perfectone.unitverify.c.coverage.report.v1",
      status: "completed",
      completionBlocked: false,
      finalAnswerAllowed: true,
      coverage: reportCoverage
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
    if (completed.status !== 0) throw new Error(`server exited ${completed.status}: ${completed.stderr}`);
    const lines = completed.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return lines.find((line) => line.id === 2)?.result?.structuredContent;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

const lineOnly = validateCoverage({ line: 100 });
if (lineOnly.status !== "blocked" || lineOnly.finalCoverageGoalReached !== false) {
  throw new Error(`line-only coverage must not satisfy the 100% goal: ${JSON.stringify(lineOnly)}`);
}

const missingFunction = validateCoverage({ line: 100, branch: 100 });
if (missingFunction.status !== "blocked" || missingFunction.finalCoverageGoalReached !== false) {
  throw new Error(`missing function coverage must not satisfy the 100% goal: ${JSON.stringify(missingFunction)}`);
}

const mcdcUnmet = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 99.9 });
if (mcdcUnmet.status !== "blocked" || mcdcUnmet.finalCoverageGoalReached !== false) {
  throw new Error(`numeric MC/DC below 100 must block final goal: ${JSON.stringify(mcdcUnmet)}`);
}

const mcdcMissing = validateCoverage({ line: 100, branch: 100, function: 100 }, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", afterCoverage: { line: 100, branch: 100, function: 100 } }
]);
if (mcdcMissing.status !== "blocked" || mcdcMissing.finalCoverageGoalReached !== false) {
  throw new Error(`missing MC/DC evidence must not satisfy final goal: ${JSON.stringify(mcdcMissing)}`);
}

const mcdcNoObligations = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: { total: 0, hit: 0, pct: null } }, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: 100, branch: 100, function: 100, mcdc: { total: 0 } } }
]);
if (mcdcNoObligations.status !== "passed" || mcdcNoObligations.finalCoverageGoalReached !== true) {
  throw new Error(`MC/DC with zero obligations should satisfy final goal: ${JSON.stringify(mcdcNoObligations)}`);
}

const completeCountObjects = validateCoverage({
  line: { covered: 10, total: 10 },
  branch: { covered: 0, total: 0 },
  function: { covered: 2, total: 2 },
  mcdc: { covered: 4, total: 4 }
}, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: { covered: 10, total: 10 }, branch: { total: 0 }, function: { covered: 2, total: 2 }, mcdc: { covered: 4, total: 4 } } }
]);
if (completeCountObjects.status !== "passed" || completeCountObjects.finalCoverageGoalReached !== true) {
  throw new Error(`coverage objects with covered/total should satisfy final goal when complete: ${JSON.stringify(completeCountObjects)}`);
}

const invalidOverCountCoverage = validateCoverage({
  line: { covered: 11, total: 10 },
  branch: { covered: 3, total: 3 },
  function: { covered: 2, total: 2 },
  mcdc: { covered: 4, total: 4 }
}, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: { covered: 11, total: 10 }, branch: { covered: 3, total: 3 }, function: { covered: 2, total: 2 }, mcdc: { covered: 4, total: 4 } } }
]);
if (invalidOverCountCoverage.status !== "blocked" || invalidOverCountCoverage.finalCoverageGoalReached !== false) {
  throw new Error(`coverage counts with covered > total should block: ${JSON.stringify(invalidOverCountCoverage)}`);
}

const invalidZeroTotalCoverage = validateCoverage({
  line: { covered: 10, total: 10 },
  branch: { covered: 1, total: 0 },
  function: { covered: 2, total: 2 },
  mcdc: { covered: 4, total: 4 }
}, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: { covered: 10, total: 10 }, branch: { covered: 1, total: 0 }, function: { covered: 2, total: 2 }, mcdc: { covered: 4, total: 4 } } }
]);
if (invalidZeroTotalCoverage.status !== "blocked" || invalidZeroTotalCoverage.finalCoverageGoalReached !== false) {
  throw new Error(`coverage counts with covered > 0 and total 0 should block: ${JSON.stringify(invalidZeroTotalCoverage)}`);
}

const completeBranchAliases = validateCoverage({
  lines: { covered: 10, total: 10 },
  branchExecuted: { covered: 3, total: 3 },
  branchTaken: { covered: 3, total: 3 },
  functions: { covered: 2, total: 2 },
  mcDc: { covered: 4, total: 4 }
}, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { lines: { covered: 10, total: 10 }, branchExecuted: { covered: 3, total: 3 }, branchTaken: { covered: 3, total: 3 }, functions: { covered: 2, total: 2 }, mcDc: { covered: 4, total: 4 } } }
]);
if (completeBranchAliases.status !== "passed" || completeBranchAliases.finalCoverageGoalReached !== true) {
  throw new Error(`coverage aliases should satisfy final goal when complete: ${JSON.stringify(completeBranchAliases)}`);
}

const missingBranchTakenAlias = validateCoverage({
  lines: { covered: 10, total: 10 },
  branchExecuted: { covered: 3, total: 3 },
  functions: { covered: 2, total: 2 },
  mcDc: { covered: 4, total: 4 }
}, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { lines: { covered: 10, total: 10 }, branchExecuted: { covered: 3, total: 3 }, functions: { covered: 2, total: 2 }, mcDc: { covered: 4, total: 4 } } }
]);
if (missingBranchTakenAlias.status !== "blocked" || missingBranchTakenAlias.finalCoverageGoalReached !== false) {
  throw new Error(`branchExecuted without branchTaken should not satisfy final goal: ${JSON.stringify(missingBranchTakenAlias)}`);
}

const finalAllowedLowCoverage = validateReportCoverageOnly({ line: 100, branch: 99, function: 100, mcdc: 100 });
if (finalAllowedLowCoverage.status !== "blocked" || finalAllowedLowCoverage.finalCoverageGoalReached !== false) {
  throw new Error(`finalAnswerAllowed reports below 100% must still block: ${JSON.stringify(finalAllowedLowCoverage)}`);
}

const finalAllowedCompleteCoverage = validateReportCoverageOnly({ line: 100, branch: 100, function: 100, mcdc: 100 });
if (finalAllowedCompleteCoverage.status !== "passed" || finalAllowedCompleteCoverage.finalCoverageGoalReached !== true) {
  throw new Error(`finalAnswerAllowed reports at 100% should pass without residual evidence: ${JSON.stringify(finalAllowedCompleteCoverage)}`);
}

const completeWithoutEvidence = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 });
if (completeWithoutEvidence.status !== "blocked" || !completeWithoutEvidence.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`complete coverage without residual evidence should block: ${JSON.stringify(completeWithoutEvidence)}`);
}

const completeWithEmptyAttempt = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [{}]);
if (completeWithEmptyAttempt.status !== "blocked" || !completeWithEmptyAttempt.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`complete coverage with empty residual attempt should block: ${JSON.stringify(completeWithEmptyAttempt)}`);
}

const completeWithFakeArtifact = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: "does-not-exist.c", afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 } }
]);
if (completeWithFakeArtifact.status !== "blocked" || !completeWithFakeArtifact.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`complete coverage with fake residual artifact should block: ${JSON.stringify(completeWithFakeArtifact)}`);
}

const completeWithExternalArtifact = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: process.execPath, reportPath: process.execPath, afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 } }
]);
if (completeWithExternalArtifact.status !== "blocked" || !completeWithExternalArtifact.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`complete coverage with external artifact path should block: ${JSON.stringify(completeWithExternalArtifact)}`);
}

const completeWithFileUrlArtifact = validateCoverageWithPrewrittenArtifacts(
  { line: 100, branch: 100, function: 100, mcdc: 100 },
  [],
  ({ residualDir }) => {
    const changedArtifact = path.join(residualDir, "residual_attempt1.c");
    const reportPath = path.join(residualDir, "residual_attempt1_report.txt");
    writeFileSync(changedArtifact, "/* generated residual attempt */\n");
    writeFileSync(reportPath, "coverage report\n");
    return [{
      attempt: 1,
      changedArtifact: pathToFileURL(changedArtifact).href,
      reportPath: pathToFileURL(reportPath).href,
      afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 }
    }];
  }
);
if (completeWithFileUrlArtifact.status !== "passed" || completeWithFileUrlArtifact.finalCoverageGoalReached !== true) {
  throw new Error(`internal file:// artifact URLs should satisfy evidence checks: ${JSON.stringify(completeWithFileUrlArtifact)}`);
}

const completeWithExternalFileUrlArtifact = validateCoverageWithPrewrittenArtifacts(
  { line: 100, branch: 100, function: 100, mcdc: 100 },
  [],
  () => [{
    attempt: 1,
    changedArtifact: pathToFileURL(process.execPath).href,
    reportPath: pathToFileURL(process.execPath).href,
    afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 }
  }]
);
if (completeWithExternalFileUrlArtifact.status !== "blocked" || !completeWithExternalFileUrlArtifact.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`external file:// artifact URLs should block: ${JSON.stringify(completeWithExternalFileUrlArtifact)}`);
}

const completeWithTraversalArtifact = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: "..\\outside.c", reportPath: "..\\outside_report.txt", afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 } }
]);
if (completeWithTraversalArtifact.status !== "blocked" || !completeWithTraversalArtifact.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`complete coverage with traversal artifact path should block: ${JSON.stringify(completeWithTraversalArtifact)}`);
}

const completeWithDirectoryArtifact = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: ".", reportPath: ".", afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 } }
]);
if (completeWithDirectoryArtifact.status !== "blocked" || !completeWithDirectoryArtifact.blockers?.includes("final_coverage_evidence_missing")) {
  throw new Error(`directory artifact paths must not count as residual evidence: ${JSON.stringify(completeWithDirectoryArtifact)}`);
}

const staleGoalFlag = validateCoverage({ line: 100, branch: 99, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: 100, branch: 99, function: 100, mcdc: 100 } }
], {
  finalCoverageGoalReached: true,
  coverageGoalReached: true
});
if (staleGoalFlag.status !== "blocked" || staleGoalFlag.finalCoverageGoalReached !== false) {
  throw new Error(`stale coverageGoalReached flags must not override measured coverage: ${JSON.stringify(staleGoalFlag)}`);
}

const complete = validateCoverage({ line: 100, branch: 100, function: 100, mcdc: 100 }, [
  { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt", afterCoverage: { line: 100, branch: 100, function: 100, mcdc: 100 } }
]);
if (complete.status !== "passed" || complete.finalCoverageGoalReached !== true) {
  throw new Error(`complete coverage should satisfy final goal: ${JSON.stringify(complete)}`);
}

console.log(JSON.stringify({
  status: "passed",
  lineOnlyGateStatus: lineOnly.status,
  missingFunctionGateStatus: missingFunction.status,
  mcdcUnmetGateStatus: mcdcUnmet.status,
  mcdcMissingGateStatus: mcdcMissing.status,
  mcdcNoObligationsGateStatus: mcdcNoObligations.status,
  completeCountObjectsGateStatus: completeCountObjects.status,
  invalidOverCountCoverageGateStatus: invalidOverCountCoverage.status,
  invalidZeroTotalCoverageGateStatus: invalidZeroTotalCoverage.status,
  completeBranchAliasesGateStatus: completeBranchAliases.status,
  missingBranchTakenAliasGateStatus: missingBranchTakenAlias.status,
  finalAllowedLowCoverageGateStatus: finalAllowedLowCoverage.status,
  finalAllowedCompleteCoverageGateStatus: finalAllowedCompleteCoverage.status,
  completeWithoutEvidenceGateStatus: completeWithoutEvidence.status,
  completeWithEmptyAttemptGateStatus: completeWithEmptyAttempt.status,
  completeWithFakeArtifactGateStatus: completeWithFakeArtifact.status,
  completeWithExternalArtifactGateStatus: completeWithExternalArtifact.status,
  completeWithFileUrlArtifactGateStatus: completeWithFileUrlArtifact.status,
  completeWithExternalFileUrlArtifactGateStatus: completeWithExternalFileUrlArtifact.status,
  completeWithTraversalArtifactGateStatus: completeWithTraversalArtifact.status,
  completeWithDirectoryArtifactGateStatus: completeWithDirectoryArtifact.status,
  staleGoalFlagGateStatus: staleGoalFlag.status,
  completeGateStatus: complete.status
}, null, 2));
