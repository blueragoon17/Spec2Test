#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const outDir = mkdtempSync(path.join(os.tmpdir(), "perfectone-retry-gate-"));
const reportDir = path.join(outDir, "mcp_reports");
const residualDir = path.join(outDir, "coding_agent_residual");
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
      nextRequiredAction: "execute_coding_agent_residual_repair_loop",
      message: "Coding-agent residual repair is mandatory before the final answer."
    },
    codingAgentResidualRepairPlan: {
      executionRequired: true,
      targets: [
        { function: "func3", unmetMetrics: ["branch"] },
        { function: "TD_main_0_0", unmetMetrics: ["function"] }
      ],
      attemptAccounting: { maxAttemptsPerFunction: 5 }
    }
  }, null, 2));
  writeFileSync(path.join(reportDir, "FINAL_REPORT_BLOCKED.md"), "# Final Report Blocked\n");
  writeFileSync(path.join(outDir, "coding_agent_final_report.html"), "<html><body>hand-written final report must not unblock final gate</body></html>");

  // This mirrors a bad run where the agent executed only two aggregate coverage-growth attempts
  // and used a TD_main probe as attempt2. It must not pass the final gate.
  for (const attempt of [1, 3]) {
    writeFileSync(path.join(residualDir, `attempt${attempt}_llvm.json`), JSON.stringify({ attempt }));
    writeFileSync(path.join(residualDir, `attempt${attempt}_report.txt`), `attempt ${attempt}\n`);
    writeFileSync(path.join(residualDir, `attempt${attempt}.info`), "TN:\n");
  }
  writeFileSync(path.join(residualDir, "attempt2_tdmain.profraw"), "");
  writeFileSync(path.join(residualDir, "attempt2_tdmain_report.txt"), "TD_main crash probe\n");
  writeFileSync(path.join(residualDir, "tdmain_probe.profraw"), "");

  const result = validate();
  if (!result) throw new Error("missing validation result");
  if (result.status !== "blocked") throw new Error(`expected retry gate to block, got ${JSON.stringify(result)}`);
  if (!result.blockers?.includes("residual_repair_attempts_without_measured_generated_artifact_changes")) {
    throw new Error(`missing aggregate retry blocker: ${JSON.stringify(result)}`);
  }
  if (result.aggregateAttemptCount !== 2) {
    throw new Error(`expected two discovered aggregate attempts, got ${result.aggregateAttemptCount}`);
  }
  const report = JSON.parse(readFileSync(path.join(reportDir, "perfectone_mcp_report.json"), "utf8"));
  if (report.finalAnswerAllowed !== false || report.completionBlocked !== true) {
    throw new Error("blocked canonical report should remain blocked");
  }
  console.log(JSON.stringify({
    status: "passed",
    gateStatus: result.status,
    blockers: result.blockers,
    aggregateAttemptCount: result.aggregateAttemptCount
  }, null, 2));
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
