#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

function plateauCoverageForAttempt(attempt) {
  const pct = attempt <= 3 ? 80 + attempt : 83;
  return { line: pct, branch: pct - 10, function: 90, mcdc: 40 };
}

function validateCase({ attempts, writeSupportArtifact, emptySupportArtifact = false, reportOnly = false, maxAttempts = 5 }) {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-attempt-evidence-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: maxAttempts }
      }
    }, null, 2));

    for (const attempt of attempts) {
      writeFileSync(path.join(residualDir, `residual_attempt${attempt}_llvm.json`), JSON.stringify({
        attempt,
        afterCoverage: plateauCoverageForAttempt(attempt)
      }));
      if (writeSupportArtifact) {
        const artifactName = reportOnly ? `residual_attempt${attempt}_report.txt` : `residual_attempt${attempt}.c`;
        writeFileSync(path.join(residualDir, artifactName), emptySupportArtifact ? "" : `attempt ${attempt}\n`);
      }
    }
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validateStructuredHistoryCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-structured-attempt-evidence-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const residualAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const changedArtifact = `residual_attempt${attempt}.c`;
      const reportPath = `residual_attempt${attempt}_report.txt`;
      writeFileSync(path.join(residualDir, changedArtifact), `/* attempt ${attempt} */\n`);
      writeFileSync(path.join(residualDir, reportPath), `attempt ${attempt} coverage report\n`);
      residualAttempts.push({ attempt, changedArtifact, reportPath, afterCoverage: plateauCoverageForAttempt(attempt) });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validateDuplicateAttemptHistoryCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-duplicate-attempt-evidence-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const residualAttempts = [
      { attempt: 1, reportPath: "residual_attempt1_report.txt" }
    ];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const changedArtifact = `residual_attempt${attempt}.c`;
      const reportPath = `residual_attempt${attempt}_report.txt`;
      writeFileSync(path.join(residualDir, changedArtifact), `/* attempt ${attempt} */\n`);
      writeFileSync(path.join(residualDir, reportPath), `attempt ${attempt} coverage report\n`);
      residualAttempts.push({ attempt, changedArtifact, reportPath, afterCoverage: plateauCoverageForAttempt(attempt) });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validatePartialHistoryWithDiscoveredArtifactsCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-partial-history-discovered-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({
      residualAttempts: [
        { attempt: 1, changedArtifact: "residual_attempt1.c", reportPath: "residual_attempt1_report.txt" }
      ]
    }, null, 2));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const targetDir = attempt === 5 ? path.join(residualDir, "nested") : residualDir;
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(path.join(targetDir, `residual_attempt${attempt}.c`), `/* discovered attempt ${attempt} */\n`);
      writeFileSync(path.join(targetDir, `residual_attempt${attempt}_llvm.json`), JSON.stringify({
        attempt,
        afterCoverage: plateauCoverageForAttempt(attempt)
      }));
    }
    writeFileSync(path.join(residualDir, "residual_attempt1_report.txt"), "attempt 1 coverage report\n");
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validateStructuredReportLogOnlyCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-structured-report-log-only-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const residualAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const reportPath = `residual_attempt${attempt}_report.txt`;
      writeFileSync(path.join(residualDir, reportPath), `attempt ${attempt} coverage report\n`);
      residualAttempts.push({ attempt, logPath: reportPath, reportPath });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validatePlainSourceOnlyCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-plain-source-only-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const residualAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const changedArtifact = `source${attempt}.c`;
      const reportPath = `residual_attempt${attempt}_report.txt`;
      writeFileSync(path.join(residualDir, changedArtifact), `/* plain source ${attempt} */\n`);
      writeFileSync(path.join(residualDir, reportPath), `attempt ${attempt} coverage report\n`);
      residualAttempts.push({ attempt, changedArtifact, reportPath, afterCoverage: plateauCoverageForAttempt(attempt) });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validateStructuredCoverageLogOnlyCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-structured-coverage-log-only-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const residualAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const coverageLog = `attempt${attempt}_coverage_aggregate.log`;
      const measurement = `residual_attempt${attempt}_llvm.json`;
      writeFileSync(path.join(residualDir, coverageLog), `attempt ${attempt} aggregate log\n`);
      writeFileSync(path.join(residualDir, measurement), JSON.stringify({
        attempt,
        afterCoverage: plateauCoverageForAttempt(attempt)
      }));
      residualAttempts.push({ attempt, logPath: coverageLog, coverageArtifact: measurement });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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

function validateSymlinkEscapeCase() {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-symlink-escape-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-outside-evidence-"));
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
        targets: [
          { function: "func1" },
          { function: "func2" }
        ],
        attemptAccounting: { maxAttemptsPerFunction: 5 }
      }
    }, null, 2));
    const externalArtifact = path.join(outsideDir, "external_attempt1.c");
    writeFileSync(externalArtifact, "/* external generated attempt */\n");
    try {
      symlinkSync(externalArtifact, path.join(residualDir, "residual_attempt1.c"), "file");
    } catch {
      return { skipped: true };
    }
    const residualAttempts = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const changedArtifact = `residual_attempt${attempt}.c`;
      const reportPath = `residual_attempt${attempt}_report.txt`;
      if (attempt > 1) writeFileSync(path.join(residualDir, changedArtifact), `/* attempt ${attempt} */\n`);
      writeFileSync(path.join(residualDir, reportPath), `attempt ${attempt} coverage report\n`);
      residualAttempts.push({ attempt, changedArtifact, reportPath, afterCoverage: plateauCoverageForAttempt(attempt) });
    }
    writeFileSync(path.join(reportDir, "coding_agent_residual_attempt_history.json"), JSON.stringify({ residualAttempts }, null, 2));
    writeFileSync(path.join(reportDir, "FINAL_RESIDUAL_SUMMARY.md"), [
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
    rmSync(outsideDir, { recursive: true, force: true });
  }
}

const sparse = validateCase({ attempts: [1, 2, 3, 4, 99], writeSupportArtifact: true });
if (sparse.status !== "blocked" || !sparse.blockers?.includes("residual_repair_attempt_sequence_incomplete")) {
  throw new Error(`sparse attempt sequence should block: ${JSON.stringify(sparse)}`);
}

const measurementOnly = validateCase({ attempts: [1, 2, 3, 4, 5], writeSupportArtifact: false });
if (measurementOnly.status !== "blocked" || !measurementOnly.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`measurement-only attempts should block: ${JSON.stringify(measurementOnly)}`);
}

const reportOnly = validateCase({ attempts: [1, 2, 3, 4, 5], writeSupportArtifact: true, reportOnly: true });
if (reportOnly.status !== "blocked" || !reportOnly.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`report-only attempts should not count as generated residual attempts: ${JSON.stringify(reportOnly)}`);
}

const structuredReportLogOnly = validateStructuredReportLogOnlyCase();
if (structuredReportLogOnly.status !== "blocked" || !structuredReportLogOnly.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`report files masquerading as logPath should not count as generated residual attempts: ${JSON.stringify(structuredReportLogOnly)}`);
}

const plainSourceOnly = validatePlainSourceOnlyCase();
if (plainSourceOnly.status !== "blocked" || !plainSourceOnly.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`plain source filenames should not count as generated residual attempts: ${JSON.stringify(plainSourceOnly)}`);
}

const structuredCoverageLogOnly = validateStructuredCoverageLogOnlyCase();
if (structuredCoverageLogOnly.status !== "blocked" || !structuredCoverageLogOnly.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`coverage aggregate logs should not count as generated residual attempts: ${JSON.stringify(structuredCoverageLogOnly)}`);
}

const emptySupportArtifacts = validateCase({ attempts: [1, 2, 3, 4, 5], writeSupportArtifact: true, emptySupportArtifact: true });
if (emptySupportArtifacts.status !== "blocked" || !emptySupportArtifacts.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
  throw new Error(`zero-byte support artifacts should block: ${JSON.stringify(emptySupportArtifacts)}`);
}

const complete = validateCase({ attempts: [1, 2, 3, 4, 5], writeSupportArtifact: true });
if (complete.status !== "passed" || complete.coveragePlateauSatisfied !== true) {
  throw new Error(`complete aggregate attempt evidence should pass: ${JSON.stringify(complete)}`);
}

const maxZero = validateCase({ attempts: [], writeSupportArtifact: false, maxAttempts: 0 });
if (maxZero.status !== "blocked" || !maxZero.blockers?.includes("coverage_growth_attempts_missing")) {
  throw new Error(`maxAttemptsPerFunction=0 must be normalized and block without attempts: ${JSON.stringify(maxZero)}`);
}

const structuredHistory = validateStructuredHistoryCase();
if (structuredHistory.status !== "passed" || structuredHistory.coveragePlateauSatisfied !== true) {
  throw new Error(`structured aggregate attempt evidence should pass: ${JSON.stringify(structuredHistory)}`);
}

const duplicateAttemptHistory = validateDuplicateAttemptHistoryCase();
if (duplicateAttemptHistory.status !== "passed" || duplicateAttemptHistory.coveragePlateauSatisfied !== true) {
  throw new Error(`duplicate attempt records should pass when one record for each attempt has complete evidence: ${JSON.stringify(duplicateAttemptHistory)}`);
}

const partialHistoryWithDiscoveredArtifacts = validatePartialHistoryWithDiscoveredArtifactsCase();
if (partialHistoryWithDiscoveredArtifacts.status !== "passed" || partialHistoryWithDiscoveredArtifacts.coveragePlateauSatisfied !== true) {
  throw new Error(`partial JSON history should be merged with discovered artifact evidence: ${JSON.stringify(partialHistoryWithDiscoveredArtifacts)}`);
}

const symlinkEscape = validateSymlinkEscapeCase();
if (!symlinkEscape.skipped && (symlinkEscape.status !== "blocked" || !symlinkEscape.blockers?.includes("residual_repair_attempt_sequence_incomplete"))) {
  throw new Error(`symlinked artifact escaping outDir should not count as residual evidence: ${JSON.stringify(symlinkEscape)}`);
}

console.log(JSON.stringify({
  status: "passed",
  sparseGateStatus: sparse.status,
  measurementOnlyGateStatus: measurementOnly.status,
  reportOnlyGateStatus: reportOnly.status,
  structuredReportLogOnlyGateStatus: structuredReportLogOnly.status,
  plainSourceOnlyGateStatus: plainSourceOnly.status,
  structuredCoverageLogOnlyGateStatus: structuredCoverageLogOnly.status,
  emptySupportArtifactsGateStatus: emptySupportArtifacts.status,
  completeGateStatus: complete.status,
  maxZeroGateStatus: maxZero.status,
  structuredHistoryGateStatus: structuredHistory.status,
  duplicateAttemptHistoryGateStatus: duplicateAttemptHistory.status,
  partialHistoryWithDiscoveredArtifactsGateStatus: partialHistoryWithDiscoveredArtifacts.status,
  symlinkEscapeGateStatus: symlinkEscape.skipped ? "skipped" : symlinkEscape.status
}, null, 2));
