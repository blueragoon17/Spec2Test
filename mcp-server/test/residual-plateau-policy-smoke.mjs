#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function runGate({ attempts, files }) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-plateau-policy-"));
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
    for (const file of files) {
      writeFileSync(path.join(residualDir, file), `evidence for ${file}\n`);
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({
      schemaVersion: "perfectone.coding-agent-residual-attempt-history.v1",
      aggregateAttempts: attempts
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

function coverage(pct) {
  return { line: pct, branch: pct, function: 95, mcdc: 50 };
}

const repeatedSameArtifact = runGate({
  files: ["residual_attempts.c", "attempt1_report.txt", "attempt2_report.txt", "attempt3_report.txt", "attempt4_report.txt", "attempt5_report.txt"],
  attempts: [80, 85, 85, 85, 85].map((pct, index) => ({
    attempt: index + 1,
    changedArtifact: "residual_attempts.c",
    reportPath: `attempt${index + 1}_report.txt`,
    replayCommand: `residual_attempts.exe ${index + 1}`,
    afterCoverage: coverage(pct)
  }))
});
if (repeatedSameArtifact.status !== "blocked" || !repeatedSameArtifact.blockers?.includes("residual_attempts_not_distinct_generated_artifact_changes")) {
  throw new Error(`same generated artifact without snapshot/hash must not count as repeated repair: ${JSON.stringify(repeatedSameArtifact)}`);
}

const sameArtifactWithHashes = runGate({
  files: ["residual_attempts.c", "attempt1_report.txt", "attempt2_report.txt", "attempt3_report.txt", "attempt4_report.txt"],
  attempts: [80, 85, 85, 85].map((pct, index) => ({
    attempt: index + 1,
    changedArtifact: "residual_attempts.c",
    changedArtifactHash: `hash-${index + 1}`,
    reportPath: `attempt${index + 1}_report.txt`,
    afterCoverage: coverage(pct)
  }))
});
if (sameArtifactWithHashes.status !== "passed" || sameArtifactWithHashes.coveragePlateauSatisfied !== true) {
  throw new Error(`same artifact with per-attempt hashes should count as distinct repair attempts: ${JSON.stringify(sameArtifactWithHashes)}`);
}

const stillIncreasing = runGate({
  files: ["residual_attempt1.c", "residual_attempt2.c", "residual_attempt3.c", "attempt1_report.txt", "attempt2_report.txt", "attempt3_report.txt"],
  attempts: [80, 85, 90].map((pct, index) => ({
    attempt: index + 1,
    changedArtifact: `residual_attempt${index + 1}.c`,
    reportPath: `attempt${index + 1}_report.txt`,
    afterCoverage: coverage(pct)
  }))
});
if (stillIncreasing.status !== "blocked" || !stillIncreasing.blockers?.includes("coverage_still_increasing_retry_required")) {
  throw new Error(`increasing coverage below 100% must require another retry: ${JSON.stringify(stillIncreasing)}`);
}

const twoNoIncrease = runGate({
  files: ["residual_attempt1.c", "residual_attempt2.c", "residual_attempt3.c", "residual_attempt4.c", "attempt1_report.txt", "attempt2_report.txt", "attempt3_report.txt", "attempt4_report.txt"],
  attempts: [80, 85, 85, 85].map((pct, index) => ({
    attempt: index + 1,
    changedArtifact: `residual_attempt${index + 1}.c`,
    reportPath: `attempt${index + 1}_report.txt`,
    afterCoverage: coverage(pct)
  }))
});
if (twoNoIncrease.status !== "passed" || twoNoIncrease.residualCoverageProgress?.consecutiveNoIncrease < 2) {
  throw new Error(`two consecutive no-increase repair attempts should allow final reporting below 100%: ${JSON.stringify(twoNoIncrease)}`);
}

console.log(JSON.stringify({
  status: "passed",
  repeatedSameArtifactGateStatus: repeatedSameArtifact.status,
  sameArtifactWithHashesGateStatus: sameArtifactWithHashes.status,
  stillIncreasingGateStatus: stillIncreasing.status,
  twoNoIncreaseGateStatus: twoNoIncrease.status
}, null, 2));
