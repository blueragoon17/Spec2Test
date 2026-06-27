#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.resolve(__dirname, "..", "src", "server.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(server, method, params = {}, timeoutMs = 120000) {
  const id = request.nextId++;
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs);
    request.pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}
request.nextId = 1;
request.pending = new Map();

function notify(server, method, params = {}) {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function startServer(cwd) {
  const server = spawn(process.execPath, [serverPath], {
    cwd,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  let stderr = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = request.pending.get(message.id);
      if (pending) {
        request.pending.delete(message.id);
        pending(message);
      }
    }
  });
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  server.stderrText = () => stderr;
  return server;
}

async function callTool(server, name, args, timeoutMs = 120000) {
  const response = await request(server, "tools/call", { name, arguments: args }, timeoutMs);
  if (response.error) throw new Error(`${name} JSON-RPC error: ${JSON.stringify(response.error)}`);
  return response.result?.structuredContent;
}

async function main() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "perfectone-filter-smoke-"));
  const outDir = path.join(projectRoot, ".perfectone", "filter-smoke");
  await mkdir(outDir, { recursive: true });
  const sourcePath = path.join(projectRoot, "target.c");
  const largeSourceFiller = `/* ${"s".repeat(1024 * 1024 + 32)} */`;
  await writeFile(sourcePath, [
    "#include <stdio.h>",
    "int alpha(int x)",
    "{",
    "  return x > 0 ? x : -x;",
    "}",
    largeSourceFiller,
    "static void beta(void)",
    "{",
    "  printf(\"beta\\n\");",
    "}",
    ""
  ].join("\n"), "utf8");

  const filler = "x".repeat(1024 * 1024 + 32);
  const ir = {
    ir_version: "test",
    filler,
    module: {
      functions: {
        alpha: { file: sourcePath, function_body: "int alpha(int x) { return x; }" },
        beta: { file: sourcePath, function_body: "static void beta(void) { }" },
        printf: { file: sourcePath, function_body: "inline int printf(...) { return 0; }" },
        "__local_stdio_printf_options": { file: sourcePath, function_body: "inline void internal(void) { }" }
      }
    }
  };
  const irPath = path.join(outDir, "ir.json");
  await writeFile(irPath, JSON.stringify(ir), "utf8");
  const runtimeDir = path.join(outDir, "alpha", "temp_run_test000001");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(path.join(runtimeDir, "native_run.status"), "139\n", "utf8");
  await writeFile(path.join(runtimeDir, "native_run.log"), "Segmentation fault\n", "utf8");
  await writeFile(path.join(runtimeDir, "input_test000001.txt"), "x=42\n", "utf8");
  const kleeDir = path.join(outDir, "beta", "klee-out");
  await mkdir(kleeDir, { recursive: true });
  await writeFile(path.join(kleeDir, "test000002.ptr.err"), "memory error: out of bound pointer\n", "utf8");
  await writeFile(path.join(kleeDir, "test000002.xml"), "<testcase><input variable=\"x\">7</input><input variable=\"mode\">1</input></testcase>\n", "utf8");
  const unitDesignDir = path.join(projectRoot, ".perfectone", "unit-design");
  await mkdir(unitDesignDir, { recursive: true });
  await writeFile(path.join(unitDesignDir, "expected-comparison.json"), JSON.stringify({
    schemaVersion: "unitverify.expected-comparison.v1",
    status: "expected_mismatch",
    summary: { total: 1, passed: 0, mismatch: 1, missingActual: 0 },
    results: [{
      oracleId: "oracle-1",
      testcaseId: "tc-1",
      unitId: "alpha",
      status: "mismatch",
      input: { x: 42 },
      expected: { return: 1 },
      actual: { return: 0 },
      checks: [{ field: "return", passed: false, expected: 1, actual: 0 }]
    }]
  }, null, 2), "utf8");
  await writeFile(path.join(outDir, "coverage_input_file.info"), [
    "TN:",
    `SF:${sourcePath}`,
    "FN:2,alpha",
    "FN:7,beta",
    "FNDA:1,alpha",
    "FNDA:1,beta",
    "FNF:2",
    "FNH:2",
    "DA:2,1",
    "DA:3,0",
    "DA:7,1",
    "DA:8,1",
    "LF:4",
    "LH:3",
    "BRDA:3,0,0,1",
    "BRDA:3,0,1,0",
    "BRF:2",
    "BRH:1",
    "MCF:0",
    "MCH:0",
    "end_of_record",
    ""
  ].join("\n"), "utf8");
  await writeFile(path.join(outDir, "coverage_manifest.json"), JSON.stringify({
    runner: "docker",
    execution_mode: "docker",
    pipeline_exit_code: 0,
    message: "smoke coverage manifest",
    replay_dedup: "input-hash",
    native_replay_timeout_sec: 5,
    testcase_counts: { candidate: 2, deduped: 2, prepared: 2, skipped: 0, quarantined: 0 },
    runner_commands: {
      container_name: "perfectone_klee_smoke",
      docker_image: "perfectone/klee-coverage-tools:llvm18-lcov-v1",
      docker_run_command: "docker run -d --name perfectone_klee_smoke --user root -v C:\\\\src:/workspace/source:ro -v C:\\\\out:/workspace/output -w /workspace perfectone/klee-coverage-tools:llvm18-lcov-v1 tail -f /dev/null",
      docker_run_command_log: ".perfectone/runner_logs/docker/docker_run_command.txt",
      docker_exec_template: "docker exec -i perfectone_klee_smoke bash -lc <coverage-stage-command>"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(outDir, "alpha", "cov_alpha_llvm.json"), JSON.stringify({
    data: [{
      files: [{
        filename: path.join(outDir, "alpha", "f_alpha.c"),
        summary: {
          lines: { count: 2, covered: 1, percent: 50 },
          branches: { count: 2, covered: 1, percent: 50 },
          functions: { count: 1, covered: 1, percent: 100 }
        }
      }],
      functions: [{
        name: "alpha",
        summary: {
          lines: { count: 2, covered: 1, percent: 50 },
          branches: { count: 2, covered: 1, percent: 50 },
          functions: { count: 1, covered: 1, percent: 100 }
        }
      }]
    }]
  }, null, 2), "utf8");
  await writeFile(path.join(outDir, "beta", "cov_beta_llvm.json"), JSON.stringify({
    data: [{
      files: [{
        filename: path.join(outDir, "beta", "f_beta.c"),
        summary: {
          lines: { count: 2, covered: 2, percent: 100 },
          branches: { count: 0, covered: 0, percent: 100 },
          functions: { count: 1, covered: 1, percent: 100 }
        }
      }],
      functions: [{
        name: "beta",
        summary: {
          lines: { count: 2, covered: 2, percent: 100 },
          branches: { count: 0, covered: 0, percent: 100 },
          functions: { count: 1, covered: 1, percent: 100 }
        }
      }]
    }]
  }, null, 2), "utf8");
  const server = await startServer(projectRoot);
  try {
    await request(server, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "filter-smoke", version: "1" }
    });
    notify(server, "notifications/initialized");
    const windowsEnv = await callTool(server, "unitverify_detect_toolchain_environment", {
      projectRoot,
      language: "c",
      sourceFiles: ["target.c"],
      environment: { hostOs: "windows", targetOs: "windows" }
    });
    assert(windowsEnv.environment?.wslDistro === null, "Windows C environment should not expose a WSL distro");
    assert(windowsEnv.cCoverageRunnerSelection?.defaultRunner === "docker", "Windows C auto must explicitly select Docker as the default runner");
    assert(windowsEnv.cCoverageRunnerSelection?.windowsCliOrchestratesWsl === false, "Windows C runner selection must state that WSL orchestration is disabled");
    assert(windowsEnv.cCoverageRunnerSelection?.wslDisabled === true, "Windows C runner selection must mark WSL disabled");
    assert(windowsEnv.dockerPreparation?.requiredForWindowsC === true, "Windows C auto should require Docker for the PerfectOne KLEE baseline");
    assert(windowsEnv.cResidualExecutionStrategy?.defaultStrategy === "docker-klee-then-windows-local-llvm-mcdc", "Windows C residual strategy must prefer local LLVM/lld-link after Docker KLEE");
    assert(windowsEnv.cResidualExecutionStrategy?.fallbackOrder?.includes("docker-klee-baseline"), "Windows C residual strategy must keep Docker KLEE baseline fallback");
    assert(windowsEnv.cResidualExecutionStrategy?.fallbackOrder?.includes("local-no-klee-coverage"), "Windows C residual strategy must keep final local no-KLEE fallback");
    assert(String(windowsEnv.setupPrompt || "").includes("Docker"), "Windows setup prompt did not describe Docker default C coverage");
    assert(String(windowsEnv.setupPrompt || "").includes("WSL is disabled"), "Windows setup prompt did not explain that WSL is disabled");

    const windowsMcdcPrepare = await callTool(server, "unitverify_prepare_windows_local_mcdc", {
      environment: { hostOs: "windows", targetOs: "windows" },
      installApproved: false
    });
    assert(["ready", "requires_user_approval"].includes(windowsMcdcPrepare.status), `Windows local MC/DC prepare returned unexpected status ${windowsMcdcPrepare.status}`);
    assert(windowsMcdcPrepare.executedInstall === false, "Windows local MC/DC prepare must not install without explicit approval");
    if (windowsMcdcPrepare.status === "ready") {
      assert(windowsMcdcPrepare.windowsLocalMcdc?.available === true, "ready Windows local MC/DC prepare must report available toolchain");
    } else {
      assert(windowsMcdcPrepare.installPlan?.requiresUserApproval === true, "missing Windows local MC/DC toolchain must require user approval before install");
    }

    const prepareProbe = await callTool(server, "perfectone_prepare_cli", {
      workspaceRoot: projectRoot,
      perfectoneCli: process.execPath,
      environment: { hostOs: "windows", targetOs: "windows" },
      execute: true
    });
    assert(prepareProbe.status === "ready", `prepare compatibility probe should discover existing CLI only, got ${prepareProbe.status}`);
    assert(prepareProbe.cCoverageRunnerSelection?.defaultRunner === "docker", "prepare probe should report Docker as Windows default C runner");
    assert(prepareProbe.cCoverageRunnerSelection?.wslDisabled === true, "prepare probe should report WSL disabled");
    assert(prepareProbe.executed === false, "perfectone_prepare_cli must not build or install from the plugin workflow");
    assert(prepareProbe.executeIgnored === true, "perfectone_prepare_cli should explicitly ignore execute=true");
    assert(Array.isArray(prepareProbe.commands) && prepareProbe.commands.length === 0, "perfectone_prepare_cli must not return build/install commands");

    const sourceDesign = await callTool(server, "unitverify_extract_design_from_source", {
      projectRoot,
      language: "c",
      sourceFiles: ["target.c"],
      outDir: path.join(projectRoot, ".perfectone", "source-design-smoke")
    });
    assert(sourceDesign.status === "passed", `source design extraction failed: ${JSON.stringify(sourceDesign.diagnostics || []).slice(0, 800)}`);
    const sourceTestDesign = JSON.parse(await readFile(sourceDesign.artifacts.testDesign, "utf8"));
    const designMethods = new Set((sourceTestDesign.testCases || []).map((item) => item.designMethod));
    assert(designMethods.has("coverage_growth"), "source-only design did not create coverage_growth testcase");
    assert(designMethods.has("boundary_value"), "source-only design did not create boundary_value testcase");
    assert(designMethods.has("equivalence_partition"), "source-only design did not create equivalence_partition testcase");
    assert((sourceTestDesign.testTechniqueSummary || []).some((item) => item.technique === "undefined_behavior_corner" && ["not_applicable", "needs_review_generated"].includes(item.status)), "source-only design did not classify UB corner-case policy");

    const jobStart = await callTool(server, "perfectone_run_filtered_c_coverage", {
      projectRoot,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"],
        outDir
      },
      outDir,
      ir: irPath,
      runner: "noop",
      timeoutMs: 120000,
      environment: { hostOs: "windows", targetOs: "windows" },
      functionReports: [{ symbol: "alpha" }, { symbol: "beta" }]
    });
    assert(["completed", "started"].includes(jobStart.status), `coverage job should start/complete without blocking, got ${jobStart.status}`);
    assert(jobStart.jobId, "coverage job did not return jobId");
    assert(jobStart.nextPollAfterMs === 30000, "coverage job did not request 30s polling");
    const jobStatus = await callTool(server, "perfectone_get_coverage_job_status", {
      jobId: jobStart.jobId,
      outDir,
      statusPath: jobStart.statusPath,
      progressPath: jobStart.progressPath
    });
    assert(jobStatus.nextPollAfterMs === 30000, "coverage status did not preserve 30s polling interval");
    assert(jobStatus.executionProfile === "quick", "coverage job did not default to quick execution profile");
    assert(jobStatus.wslDisabled === true, "coverage job should report WSL disabled");
    assert(jobStatus.replayPolicy?.replayMaxCasesPerFunction === 128, "coverage job did not default to capped quick replay");
    assert(jobStatus.replayPolicy?.nativeReplayTimeout === 5, "coverage job did not default to short quick native replay timeout");
    await writeFile(path.join(outDir, "coverage_partial_manifest.json"), JSON.stringify({
      stage: "completed",
      runner: "noop",
      testcase_counts: { candidate: 0, deduped: 0, prepared: 0, skipped: 0, quarantined: 0 }
    }, null, 2), "utf8");
    const outputLegacyDir = path.join(projectRoot, "Output", "legacy-c-run");
    await mkdir(path.join(outputLegacyDir, "alpha", ".perfectone", "docker_logs"), { recursive: true });
    await mkdir(path.join(outputLegacyDir, "alpha", "temp_run_test000001"), { recursive: true });
    await writeFile(path.join(outputLegacyDir, "alpha", ".perfectone", "docker_logs", "klee_run.status"), "0\n", "utf8");
    await writeFile(path.join(outputLegacyDir, "alpha", "temp_run_test000001", "native_run.status"), "139\n", "utf8");
    await writeFile(path.join(outputLegacyDir, "coverage_partial_manifest.json"), JSON.stringify({
      stage: "native_replay",
      runner: "docker",
      testcase_counts: { candidate: 3, deduped: 2, prepared: 1, skipped: 0, quarantined: 1 }
    }, null, 2), "utf8");
    const detectedProject = await callTool(server, "perfectone_detect_c_project", {
      projectRoot,
      environment: { hostOs: "windows", targetOs: "windows" },
      maxPreviousRuns: 5
    });
    assert(detectedProject.previousRuns?.found === true, "C project detection should report existing PerfectOne results");
    assert(detectedProject.previousRuns?.defaultAction === "new_run", "Previous-run prompt must default to new run");
    assert(detectedProject.previousRuns?.requiresUserChoice === true, "Existing results should require an explicit reuse/new-run choice");
    const legacyRun = detectedProject.previousRuns?.runs?.find((run) => run.outDir === outputLegacyDir);
    assert(legacyRun, "Output folder previous run was not discovered");
    assert(legacyRun.testcaseExecution?.kleeCompleted === 1, "Output previous run did not summarize KLEE status");
    assert(legacyRun.testcaseExecution?.nativeReplayCrash === 1, "Output previous run did not summarize native replay crash status");
    assert(legacyRun.testcaseExecution?.testcaseCounts?.candidate === 3, "Output previous run did not carry testcase count summary");
    const fullPrompt = await callTool(server, "perfectone_run_c_unit_verify_full", {
      perfectoneCli: process.execPath,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"]
      },
      environment: { hostOs: "windows", targetOs: "windows" }
    });
    assert(fullPrompt.status === "previous_results_found", "Full C flow should stop and ask before reusing existing results");
    assert(fullPrompt.defaultAction === "new_run", "Full C previous-results prompt must default to new run");
    assert(fullPrompt.requiresUserChoice === true, "Full C previous-results prompt should require user choice");
    const commandJson = JSON.parse(await readFile(path.join(outDir, ".perfectone", "coverage_jobs", jobStart.jobId, "command.json"), "utf8"));
    assert(commandJson.requestedTimeoutMs === 120000, `coverage job did not record the caller timeout, got ${commandJson.requestedTimeoutMs}`);
    assert(commandJson.timeoutMs === 1800000, `coverage job did not clamp the child process timeout to 30 minutes, got ${commandJson.timeoutMs}`);
    const jobCollect = await callTool(server, "perfectone_collect_coverage_job_result", {
      jobId: jobStart.jobId,
      outDir,
      statusPath: jobStart.statusPath,
      progressPath: jobStart.progressPath
    });
    assert(jobCollect.report?.cUnitVerificationFlow?.candidateCounts?.mcpFunctionReports === 2, "coverage collect did not carry unit-verify functionReports");
    assert(jobCollect.report?.cUnitVerificationFlow?.codingAgentResidual?.residualMcdcStrategy?.defaultPath === "windows-local-llvm-lld-link", "coverage collect did not preserve Windows local residual MC/DC first path");
    assert(jobCollect.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.parallelExecution === true, "coverage collect did not preserve residual parallel execution policy");
    assert(jobCollect.reportLinks?.testcaseIo && jobCollect.reportLinks?.sourceDesignMd && jobCollect.reportLinks?.ubAsan && jobCollect.reportLinks?.coverageLimits, "coverage collect did not render supplemental C report links");

    const result = await callTool(server, "perfectone_run_filtered_c_coverage", {
      projectRoot,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"],
        outDir
      },
      outDir,
      ir: irPath,
      runner: "noop",
      blocking: true,
      environment: { hostOs: "windows", targetOs: "windows" },
      coverageOptions: {
        heterogeneous: true,
        structDepth: 7,
        pointerDepth: 4,
        pointerArraySize: 3,
        arrayMaxDims: 2,
        famSize: 1
      }
    });

    assert(result.status === "needs_coding_agent_residual", `coverage artifacts below 100% should request Coding Agent Residual, got ${result.status}; result=${JSON.stringify(result).slice(0, 1200)}`);
    assert(result.sourceTargetFilter?.filterSource === "ir", `expected IR filter, got ${result.sourceTargetFilter?.filterSource}`);
    assert(result.sourceTargetFilter?.functionCount === 2, `expected 2 source functions, got ${result.sourceTargetFilter?.functionCount}`);
    assert(result.sourceTargetFilter?.rawIrFunctionCount === 4, `expected 4 raw IR functions, got ${result.sourceTargetFilter?.rawIrFunctionCount}`);
    assert(result.sourceTargetFilter?.excludedIrFunctionCount === 2, `expected 2 excluded IR functions, got ${result.sourceTargetFilter?.excludedIrFunctionCount}`);
    assert(result.sourceTargetFilter?.functions.includes("alpha"), "alpha missing from filter");
    assert(result.sourceTargetFilter?.functions.includes("beta"), "beta missing from filter");
    assert(!result.sourceTargetFilter?.functions.includes("printf"), "printf leaked into source target filter");
    assert(!result.sourceTargetFilter?.functions.includes("__local_stdio_printf_options"), "stdio helper leaked into source target filter");
    assert(result.coverageExecution?.dockerExplicit === false, "Windows auto/noop coverage report must not mark Docker explicit");
    assert(result.coverageExecution?.wslDisabled === true, "Coverage report should mark WSL disabled");
    assert(result.coverageExecution?.runnerCommands?.docker_run_command?.startsWith("docker run -d"), "Coverage report should preserve the raw Docker run command");
    assert(result.coverageExecution?.runnerCommands?.docker_exec_template?.includes("docker exec"), "Coverage report should preserve the Docker exec template");
    assert(result.coverageExecution?.docker?.preparation?.before?.installCommand?.includes("Docker.DockerDesktop"), "Coverage report should include the Windows Docker install command");
    assert(result.coverageExecution?.coverageOptions?.mcpRecommendation === false, "MCP should not recommend C exploration parameters");
    assert(result.coverageExecution?.coverageOptions?.executionProfile === "quick", "Coverage tuning did not default to quick profile");
    assert(result.coverageExecution?.coverageOptions?.kleeMaxTime === 60, "Quick profile did not default KLEE max time to 60 seconds");
    assert(result.coverageExecution?.coverageOptions?.kleeMaxMemory === 4096, "Quick profile did not default KLEE memory to 4096 MB");
    assert(result.coverageExecution?.coverageOptions?.replayMaxCasesPerFunction === 128, "Quick profile did not default replay cap to 128");
    assert(result.coverageExecution?.coverageOptions?.nativeReplayTimeout === 5, "Quick profile did not default native replay timeout to 5 seconds");
    assert(result.coverageExecution?.replayPolicy?.dockerKleeParallel === false, "noop runner should not claim Docker KLEE parallel execution");
    assert(result.coverageExecution?.replayPolicy?.windowsLocalResidualParallel === true, "coverage report should describe Windows local residual parallelism");
    assert(result.coverageExecution?.coverageOptions?.heterogeneous === true, "Coding-agent-selected heterogeneous option was not preserved");
    assert(result.coverageExecution?.coverageOptions?.structDepth?.value === 5, "structDepth was not clamped to security maximum 5");
    assert(result.coverageExecution?.coverageOptions?.structDepth?.clamped === true, "structDepth clamp was not reported");
    assert(result.coverageExecution?.coverageOptions?.pointerArraySize === 3, "pointerArraySize was not preserved");
    assert(result.coverageExecution?.coverageOptions?.arrayMaxDims === 2, "arrayMaxDims was not preserved");
    assert(result.coverageExecution?.coverageOptions?.famSize === 1, "famSize was not preserved");
    assert(result.coverageExecution?.coverageOptions?.ignored?.some((item) => item.option === "pointerDepth"), "pointerDepth was not ignored explicitly");
    assert(result.report?.diagnostics?.some((item) => item.code === "struct_depth_clamped"), "struct depth clamp diagnostic missing");
    assert(result.report?.diagnostics?.some((item) => item.code === "pointer_depth_ignored"), "pointer depth ignored diagnostic missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.mode === "per-function-coverage-growth-loop", "Coding-agent residual iteration policy missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.residualMcdcStrategy?.defaultPath === "windows-local-llvm-lld-link", "Coding-agent residual strategy did not prefer Windows local LLVM/lld-link");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.parallelExecution === true, "Coding-agent residual strategy did not enable parallel residual jobs");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.fallbackOrder?.join(",") === "docker-klee-baseline,windows-local-llvm-lld-link,local-no-klee", "Coding-agent residual fallback order is wrong");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.owner === "Coding Agent", "Residual owner should be Coding Agent");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.maxAttempts === 5, "Coding-agent residual max attempts is not 5");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.noImprovementLimit === 1, "Coding-agent residual no-improvement early-stop limit is not 1");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.continuationRule?.includes("coverage-increasing"), "Coding-agent residual continuation rule missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.iterationPolicy?.mustDirectlyModifyGeneratedArtifacts === true, "Coding-agent residual policy must require generated artifact edits");
    assert(result.report?.cUnitVerificationFlow?.codingAgentTestAugmentation?.executionRequired === true, "Coding-agent test augmentation must be required after baseline coverage");
    assert(result.report?.cUnitVerificationFlow?.codingAgentTestAugmentation?.codeOnlyDefault?.alwaysExecute?.includes("coverage_growth"), "coverage-growth augmentation missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentTestAugmentation?.codeOnlyDefault?.alwaysExecute?.includes("boundary_value"), "boundary-value augmentation missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentTestAugmentation?.codeOnlyDefault?.alwaysExecute?.includes("equivalence_partition"), "equivalence-partition augmentation missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentTestAugmentation?.codeOnlyDefault?.conditionalExecute?.includes("undefined_behavior_corner"), "UB conditional augmentation missing");
    assert(Array.isArray(result.report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction), "Coding-agent residual per-function loop missing");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction?.every((item) => item.residualLoop?.maxAttempts === 5), "Per-function residual max attempts is not 5");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction?.every((item) => item.residualLoop?.noImprovementLimit === 1), "Per-function residual no-improvement early-stop limit is not 1");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction?.every((item) => item.residualLoop?.continuationRule?.includes("next attempt is mandatory")), "Per-function residual continuation rule missing");
    assert(result.report?.residualTargets?.some((item) => item.function === "alpha" && item.reason === "per_function_coverage_below_goal"), "alpha per-function residual target was not detected");
    assert(!result.report?.residualTargets?.some((item) => item.function === "beta"), "beta should not be a residual target when per-function coverage is 100%");
    assert(result.report?.cUnitVerificationFlow?.codingAgentResidual?.perFunction?.some((item) => item.function === "alpha" && item.unmetMetrics?.line && item.unmetMetrics?.branch), "Coding Agent Residual loop did not carry alpha unmet metrics");
    assert(result.codingAgentResidualRepairPlan?.executionRequired === true, "Coding-agent residual repair plan was not marked required");
    assert(result.codingAgentResidualRepairPlan?.attemptAccounting?.maxAttemptsPerFunction === 5, "Coding-agent residual repair plan max attempts is not 5");
    assert(result.codingAgentResidualRepairPlan?.attemptAccounting?.runnerKleeRerunsCountAsCodingAgentAttempts === false, "Runner KLEE reruns must not count as coding-agent residual attempts");
    assert(result.codingAgentResidualRepairPlan?.attemptAccounting?.mustModifyGeneratedArtifact === true, "Coding-agent residual attempts must require generated artifact edits");
    assert(result.codingAgentResidualRepairPlan?.targets?.some((item) => item.function === "alpha"), "Coding-agent residual repair plan did not include alpha");
    assert(result.completionBlocked === true, "needs_coding_agent_residual must block completion");
    assert(result.finalAnswerAllowed === false, "needs_coding_agent_residual must mark final answers as disallowed");
    assert(result.nextRequiredAction === "execute_coding_agent_residual_repair_loop", "needs_coding_agent_residual must name the next required action");
    assert(result.codingAgentResidualActionRequired?.required === true, "coding-agent residual actionRequired block missing");
    assert(result.codingAgentResidualActionRequired?.completionBlocked === true, "coding-agent residual action must block completion");
    assert(result.codingAgentResidualActionRequired?.finalAnswerAllowed === false, "coding-agent residual action must disallow final answers");
    assert(result.codingAgentResidualActionRequired?.message?.includes("If a residual attempt increases coverage"), "coding-agent residual action must force another attempt after coverage increase");
    assert(result.codingAgentResidualActionRequired?.prohibitedShortcuts?.some((item) => item.includes("Do not stop with a summary")), "coding-agent residual action did not prohibit summary-only completion");
    assert(result.codingPlatformPrompt?.includes("Coding Agent residual repair is required now"), "Coding Platform prompt does not force coding-agent residual repair");
    assert(result.codingPlatformPrompt?.includes("direct generated harness"), "Coding Platform prompt does not require direct generated harness/fixture edits");
    assert(result.codingPlatformPrompt?.includes("do not modify the user source file"), "Coding Platform prompt does not protect the user source file");
    assert(result.codingPlatformPrompt?.includes("Docker/local KLEE reruns"), "Coding Platform prompt does not exclude runner KLEE reruns from coding-agent attempts");
    assert(Array.isArray(result.recommendedActions) && result.recommendedActions.length > 0, "Recommended actions for coding-agent residual repair missing");
    assert(result.report?.cUnitVerificationFlow?.coverageCumulative?.codingAgentIncrease?.display?.line === "+pending", "Coverage cumulative pending increase missing");
    assert(result.failureEvidence?.summary?.segfaults === 1, `expected 1 segfault, got ${result.failureEvidence?.summary?.segfaults}`);
    assert(result.failureEvidence?.summary?.kleeErrors === 1, `expected 1 KLEE error, got ${result.failureEvidence?.summary?.kleeErrors}`);
    assert(result.failureEvidence?.summary?.expectedMismatches === 1, `expected 1 expected mismatch, got ${result.failureEvidence?.summary?.expectedMismatches}`);
    assert(result.failureEvidence?.cases?.some((item) => item.replay?.mcpTool === "perfectone_replay"), "failure evidence did not include replay descriptor");
    assert(result.tokenUsage?.schemaVersion === "unitverify.plugin-token-usage.v1", "plugin token usage schema missing");
    assert(result.tokenUsage?.observedSurfaces?.includes("skill"), "plugin token usage did not include skill surface");
    assert(result.tokenUsage?.observedSurfaces?.includes("oauth"), "plugin token usage did not include OAuth surface");
    assert(result.tokenUsage?.total?.estimatedTokens > 0, "plugin token usage did not count tokens");
    const html = await readFile(path.join(outDir, "mcp_reports", "perfectone_mcp_report.html"), "utf8");
    assert(html.includes("Failure Evidence and Replay"), "HTML report missing failure evidence section");
    assert(html.includes("Docker execution command"), "HTML report missing Docker execution command row");
    assert(html.includes("docker run -d --name perfectone_klee_smoke"), "HTML report missing raw Docker run command");
    assert(html.includes("Docker install command"), "HTML report missing Docker install command row");
    assert(html.includes("Docker.DockerDesktop"), "HTML report missing Windows Docker install command");
    assert(html.includes("Token Usage"), "HTML report missing token usage section");
    assert(html.includes("Residual Loop Policy"), "HTML report missing residual loop policy section");
    assert(html.includes("Coding Agent Residual Targets"), "HTML report missing residual target section");
    assert(html.includes("Coding Agent Residual Repair Plan"), "HTML report missing coding-agent residual repair plan");
    assert(html.includes("Coding Agent Additional Test Augmentation"), "HTML report missing coding-agent test augmentation section");
    assert(html.includes("coverage_growth"), "HTML report missing coverage-growth augmentation method");
    assert(html.includes("boundary_value"), "HTML report missing boundary-value augmentation method");
    assert(html.includes("equivalence_partition"), "HTML report missing equivalence-partition augmentation method");
    assert(html.includes("undefined_behavior_corner"), "HTML report missing UB corner augmentation method");
    assert(html.includes("directly edit generated harnesses"), "HTML report missing direct generated harness edit requirement");
    assert(html.includes("Docker/local KLEE reruns"), "HTML report missing runner KLEE retry accounting rule");
    assert(html.includes("per_function_coverage_below_goal"), "HTML report missing per-function coverage residual reason");
    assert(html.includes("PerfectOne Coverage"), "HTML report missing PerfectOne cumulative coverage section");
    assert(html.includes("Coding Agent Applied Cumulative"), "HTML report missing coding-agent cumulative coverage section");
    assert(html.includes("Coding Agent Increase"), "HTML report missing coding-agent increase section");
    assert(html.includes("5 coding-agent residual attempts per function"), "HTML report missing 5-attempt coding-agent residual budget");
    assert(html.includes("Early-stop evidence threshold"), "HTML report missing early-stop evidence threshold");
    assert(html.includes("not the primary retry count"), "HTML report must not present the no-improvement threshold as the primary retry count");
    assert(html.includes("Struct depth"), "HTML report missing coverage option clamp section");
    assert(html.includes("OAuth configured"), "HTML report missing OAuth token usage status");
    assert(html.includes("x=42") || html.includes("&quot;x&quot;:42"), "HTML report missing failure input value");
    assert(html.includes("perfectone_replay"), "HTML report missing replay tool");
    const failureJson = JSON.parse(await readFile(path.join(outDir, "mcp_reports", "failure_evidence.json"), "utf8"));
    assert(failureJson.summary?.total === 3, `failure evidence json expected 3 cases, got ${failureJson.summary?.total}`);
    const tokenJson = JSON.parse(await readFile(path.join(outDir, "mcp_reports", "token_usage.json"), "utf8"));
    assert(tokenJson.scope === "plugin-bundle-observable-io", "token usage json scope mismatch");
    const residualRequiredDoc = await readFile(path.join(outDir, "mcp_reports", "coding_agent_residual_required.md"), "utf8");
    assert(residualRequiredDoc.includes("finalAnswerAllowed: false"), "residual required doc must disallow final answer");
    assert(residualRequiredDoc.includes("execute_coding_agent_residual_repair_loop"), "residual required doc must name required next action");

    const aggregateFailOutDir = path.join(projectRoot, ".perfectone", "aggregate-fail");
    await mkdir(path.join(aggregateFailOutDir, ".perfectone", "runner_logs", "docker"), { recursive: true });
    const aggregateFailIrPath = path.join(aggregateFailOutDir, "ir.json");
    await writeFile(aggregateFailIrPath, JSON.stringify(ir), "utf8");
    await writeFile(path.join(aggregateFailOutDir, "coverage_manifest.json"), JSON.stringify({
      pipeline_exit_code: 50,
      message: "Failed to aggregate coverage outputs (see .perfectone/runner_logs/docker/coverage_aggregate.log)",
      files: {
        merged_profdata: { path: path.join(aggregateFailOutDir, "merged.profdata"), exists: false, size: 0 },
        coverage_input_file_info: { path: path.join(aggregateFailOutDir, "coverage_input_file.info"), exists: false, size: 0 }
      }
    }, null, 2), "utf8");
    await writeFile(path.join(aggregateFailOutDir, ".perfectone", "runner_logs", "docker", "coverage_aggregate.log"), "No per-function coverage info files found\n", "utf8");
    const aggregateFail = await callTool(server, "perfectone_run_filtered_c_coverage", {
      projectRoot,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"],
        outDir: aggregateFailOutDir
      },
      outDir: aggregateFailOutDir,
      ir: aggregateFailIrPath,
      runner: "noop",
      blocking: true,
      environment: { hostOs: "windows", targetOs: "windows" }
    });
    const aggregateCodes = new Set((aggregateFail.diagnostics || []).map((item) => item.code));
    assert(aggregateCodes.has("coverage_aggregation_failed"), "aggregate failure did not report coverage_aggregation_failed");
    assert(aggregateCodes.has("coverage_aggregation_no_per_function_info"), "aggregate failure did not report missing per-function coverage info");
    assert(aggregateCodes.has("coverage_profdata_missing"), "aggregate failure did not report missing profdata");
    assert(aggregateCodes.has("coverage_lcov_missing"), "aggregate failure did not report missing LCOV");

    const disabledWslOutDir = path.join(projectRoot, ".perfectone", "disabled-wsl-runner");
    await mkdir(disabledWslOutDir, { recursive: true });
    const disabledWslIrPath = path.join(disabledWslOutDir, "ir.json");
    await writeFile(disabledWslIrPath, JSON.stringify(ir), "utf8");
    const disabledWsl = await callTool(server, "perfectone_run_filtered_c_coverage", {
      perfectoneCli: process.execPath,
      projectRoot,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"],
        outDir: disabledWslOutDir
      },
      outDir: disabledWslOutDir,
      ir: disabledWslIrPath,
      runner: "wsl",
      blocking: true,
      environment: { hostOs: "windows", targetOs: "windows" }
    });
    assert(disabledWsl.status === "failed", `disabled WSL runner should fail fast, got ${disabledWsl.status}`);
    assert(disabledWsl.blockingDiagnostics?.some((item) => item.code === "wsl_runner_disabled"), "disabled WSL runner did not report wsl_runner_disabled");
    assert((disabledWsl.coverageExecution?.command || []).length === 0, "MCP should not execute CLI when WSL runner is disabled");
    assert(disabledWsl.coverageExecution?.wslDisabled === true, "disabled WSL result should report WSL disabled");

    const badDockerOutDir = path.join(projectRoot, ".perfectone", "bad-docker-tool");
    await mkdir(badDockerOutDir, { recursive: true });
    const badDockerIrPath = path.join(badDockerOutDir, "ir.json");
    await writeFile(badDockerIrPath, JSON.stringify(ir), "utf8");
    const badDocker = await callTool(server, "perfectone_run_filtered_c_coverage", {
      perfectoneCli: process.execPath,
      projectRoot,
      request: {
        schemaVersion: "perfectone.unitverify.v1",
        projectRoot,
        language: "c",
        sourceFiles: ["target.c"],
        outDir: badDockerOutDir
      },
      outDir: badDockerOutDir,
      ir: badDockerIrPath,
      runner: "docker",
      blocking: true,
      environment: { hostOs: "windows", targetOs: "windows" },
      coverageOptions: {
        clang: "clang",
        llvmProfdata: "llvm-profdata"
      }
    });
    assert(badDocker.status === "failed", `plain Docker clang override should fail fast, got ${badDocker.status}`);
    assert(badDocker.blockingDiagnostics?.some((item) => item.code === "docker_mcdc_requires_llvm18_tool"), "plain Docker LLVM tool override was not blocked");
    assert((badDocker.coverageExecution?.command || []).length === 0, "MCP should not execute Docker coverage when plain LLVM tool override is blocked");
    assert(badDocker.coverageExecution?.docker?.toolchain?.clang === "/usr/bin/clang-18", "Docker MC/DC default clang should be pinned to /usr/bin/clang-18");

    process.stdout.write(`${JSON.stringify({
      status: "passed",
      projectRoot,
      filterSource: result.sourceTargetFilter.filterSource,
      functionCount: result.sourceTargetFilter.functionCount,
      rawIrFunctionCount: result.sourceTargetFilter.rawIrFunctionCount,
      excludedIrFunctionCount: result.sourceTargetFilter.excludedIrFunctionCount,
      regex: result.sourceTargetFilter.regex,
      codingAgentResidualPolicy: result.report.cUnitVerificationFlow.codingAgentResidual.iterationPolicy,
      coverageOptions: result.coverageExecution.coverageOptions,
      failureEvidence: result.failureEvidence.summary,
      estimatedPluginTokens: result.tokenUsage.total.estimatedTokens
    }, null, 2)}\n`);
  } finally {
    server.kill();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
