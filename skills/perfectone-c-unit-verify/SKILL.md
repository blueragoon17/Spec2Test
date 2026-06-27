---
name: perfectone-c-unit-verify
description: Use when the user asks a coding agent to create, run, or improve C unit verification with PerfectOne CLI, filtered KLEE/CBMC/libFuzzer/native artifacts, MC/DC coverage, generated harnesses, or the PerfectOne MCP server. Prefer this only for .c files.
---

# PerfectOne C Unit Verify

## Scope

Use this skill for C targets only. For `.cc`, `.cpp`, `.cxx`, or non-C files, do not route through PerfectOne MCP unless the user explicitly asks for a C/PerfectOne experiment.

## Default C Flow

1. Confirm the target is a `.c` source file. Build a `perfectone.unitverify.v1` request with `language: "c"`, exact `sourceFiles`, `compileDb` when present, `coverageGoal` fixed at 100% for line/branch/function/MC/DC where measurable, strategy default `["klee", "native"]`, and `outDir`.
   - Include `environment` when OS, target OS, compiler, sysroot, chip, RTOS, include/library paths, defines, or build flags are known.
   - If language-independent unit design artifacts exist, attach their paths under `unitDesignArtifacts` without changing the C execution policy.
   - Treat manual testcases, assertions, and oracles from `unit-design-verify` as input evidence for C harness/testcase generation and expected-value comparison.
2. Before starting execution, call `perfectone_detect_c_project` with `projectRoot`, exact `sourceFiles`, current/planned `outDir` when known, and `environment`; inspect `previousRuns`.
   - MCP scans `.perfectone`, `Output`, `output`, `perfectone-output`, and `perfectone_output` style result roots. Do not assume only `.perfectone` contains previous runs.
   - If prior PerfectOne C results are found, ask the user whether to reuse one. The default choice is **new run**.
   - Phrase the question shortly, for example: `기존 PerfectOne C 검증 결과가 있습니다. 재사용할까요? 기본값은 신규 실행입니다.`
   - Include enough context to choose safely: run `outDir`, status, last modified time, coverage values, and testcase execution summary such as KLEE completed/partial, native replay completed/crash/timeout, and residual artifact presence.
   - If the user explicitly chooses reuse, call `perfectone_run_c_unit_verify_full` with `reusePreviousRun: true` and `previousRunOutDir` set to the selected run.
   - If the user does not explicitly choose reuse, start a new run with `reusePreviousRun: false`. Prefer a fresh timestamped `outDir` so old coverage, KLEE, and residual artifacts are not mistaken for the new run.
   - Do not silently reuse old results.
3. Call `unitverify_detect_toolchain_environment`, `perfectone_capabilities`, then prefer the C-only orchestration tool `perfectone_run_c_unit_verify_full`. Do not build PerfectOne, Docker images, WSL packages, or Linux CLI binaries from this skill workflow. Windows local LLVM for residual MC/DC is the only toolchain install path this preview may request, and only after explicit user approval.
4. Treat `coverage_unmet` from `unit-verify` as artifact generation complete, not as verification failure. At this point PerfectOne may have produced split/stub/harness artifacts without coverage evidence.
5. Build a source-file target filter from functions actually defined in the requested `.c` file. Header, include, runtime, and system functions must not enter the coverage candidate set.
6. Run C coverage before coding-agent residual repair:
   - On Windows, use `runner: "auto"` with `runnerPolicy: "os-default"`; MCP must select Docker for the PerfectOne KLEE baseline.
   - On Linux or macOS, use `runner: "auto"` with `runnerPolicy: "os-default"`; MCP should select native PerfectOne+KLEE/LLVM first and must not automatically fall back to Docker.
   - WSL is disabled for this plugin path because artifact synchronization overhead is too high. Do not request `runner: "wsl"`, `--wsl-distro`, or `--wsl-path-mode`.
   - Docker setup/image preparation belongs to `executionProfile: "setup"` or an explicit operations request. Quick/full execution should reuse the prepared image and must not rebuild/pull on every run.
   - If Docker is missing on Windows, report the install command before declaring the blocker:
     ```powershell
     winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
     ```
   - Default coverage execution profile is `executionProfile: "quick"`, not full analysis. Quick runs all source-target functions with function-level KLEE timeout/capped replay and then hands remaining 100% coverage gaps to Coding Agent residual repair.
   - Use `executionProfile: "full"` only when the user explicitly asks for a full/long analysis.
   - Quick must not perform Docker image pull/build/preparation. Environment setup belongs to `executionProfile: "setup"` or an explicit operations request.
   - The coverage phase must pass `--func_regex` or the MCP equivalent source-target filter.
   - Enable KLEE coverage, branch coverage, and MC/DC measurement.
   - For embedded, do not execute until compile DB, CMake toolchain file, or compiler/toolchainPrefix plus sysroot is supplied.
   - By default the MCP coverage call returns a background job within the host timeout. Treat MCP call timeout and coverage execution timeout as separate values: even if the host/tool call supplies `timeoutMs: 120000`, the background coverage child process must clamp its execution kill timer to at least 30 minutes. Poll `perfectone_get_coverage_job_status` every 30 seconds and report the current phase, current function, KLEE complete/partial counts, native replay complete/crash/timeout counts, profraw count, and recent log path to the user.
   - When the job completes, call `perfectone_collect_coverage_job_result` to normalize coverage, residual targets, report links, and diagnostics. Use `blocking: true` only for short smoke tests or explicit user requests.
7. Do not finish as harness-only after artifact generation. Harness-only coverage is acceptable only as coding-agent residual fill after filtered Docker KLEE/MCDC evidence exists or after a concrete Docker/native MCDC blocker is reported.
8. Preferred split after the baseline: Docker owns source-target filtered KLEE testcase generation and baseline evidence; Windows local LLVM 21+ with `lld-link.exe` owns Coding Agent residual native replay and MC/DC coverage aggregation when available. Residual harness compile/replay/coverage jobs should be parallelized when their generated artifacts and profile files are disjoint.
9. When PerfectOne functionReports omit a source target such as `TD_main_0_0`, report that omission separately. Do not treat omission-only repair as the whole residual step.
10. Use coding-agent residual repair for every source-target function whose coverage is below the 100% goal after PerfectOne KLEE results. Residual is per-function unmet coverage, not just missing functions. Keep KLEE coverage and coding-agent residual coverage as separate report sections.
11. After the PerfectOne baseline, always perform Coding Agent test augmentation before the final answer, even when the PerfectOne baseline reaches the 100% coverage goal:
   - Always generate and execute coverage-growth testcases.
   - Always generate and execute boundary-value testcases.
   - Always generate and execute equivalence-partition testcases.
   - Review for UB corner-case risk and execute UB testcases only when the code plausibly contains null/invalid pointer, bounds, signed overflow, divide-by-zero, uninitialized-read, invalid-state, or size-mismatch risk.
   - Review for AB corner-case risk and execute AB testcases only when the code/spec plausibly contains invalid mode/state, error return, exception, timeout, resource exhaustion, or unsupported input format risk.
   - When specification artifacts or specification-derived manual tests are attached, also execute manual testcase seeds, decision-table, state-transition, boundary-value, and equivalence-partition testcases and record why each technique was applied or marked `not_applicable`.
12. Before any final answer or final HTML summary, call `perfectone_validate_c_final_evidence` with the current `outDir`.
   - If it returns `status: "blocked"` or `finalAnswerAllowed: false`, do not summarize the run as complete. Continue the required residual loop or report the exact external blocker.
   - A hand-written Codex summary HTML must not replace the MCP final evidence gate.
   - Do not call the final answer complete while `mcp_reports/FINAL_REPORT_BLOCKED.md` exists or `mcp_reports/final_evidence_gate.json` says blocked.
   - Do not create or present `coding_agent_final_report.html` as a final report before `perfectone_validate_c_final_evidence` returns `status: "passed"`.
   - If a hand-written or generated HTML summary exists while the MCP gate is blocked, treat that HTML as a draft only and continue the residual loop.

## Unit Design Artifact Handoff

- Accept `unitverify.spec-analysis.v1`, `unitverify.test-design.v1`, `unitverify.assertion.v1`, `unitverify.oracle.v1`, `unitverify.traceability.v1`, and `unitverify.review.v1` as language-independent input.
- If the user has only provided C source code and no specification, first use `unitverify_extract_design_from_source` to create source-derived draft artifacts, then attach those artifact paths under `unitDesignArtifacts`.
- Do not switch C verification to standalone Clang AST just because Clang is installed. C authority remains PerfectOne; source-derived extraction is a review/design aid before PerfectOne execution or a fallback draft when PerfectOne IR is not yet available.
- Do not reinterpret C as a general path. These artifacts guide C testcase/oracle/assertion generation, but PerfectOne remains the C backend.
- Preserve review status in reports. `specified` and `approved` values can be used as authoritative; `inferred` values must show evidence; `missing` or `needs_review` values must be called out as draft evidence unless the user explicitly approves them.
- Expected-value mismatch is not a coverage failure. Report it separately from compile failure, runtime failure, KLEE blocker, MC/DC blocker, and coverage unmet.
- Link requirement IDs, testcase IDs, assertion IDs, oracle IDs, generated harnesses, KLEE artifacts, coverage, and replay result in the final traceability report when available.

## Source Target Filter

- Extract only real function definitions from requested `.c` files.
- Exclude prototypes, typedef function pointers, macros, included headers, generated stubs, and system/runtime symbols.
- For every runner, require a source-target regex such as `^(?:TD_main_0_0|func1|func2)$`.
- If the runner discovers more functions than the source-target count, classify the run as contaminated by header/system functions and do not accept it as final evidence. For explicit Docker, also record Docker discovered function count.

## C Coverage Execution

Windows local residual MC/DC path (first after KLEE baseline):

- Use this after the PerfectOne KLEE baseline for Coding Agent residual harnesses and testcase augmentation.
- Required tools: LLVM 21 or newer `clang.exe`, version-matched `lld-link.exe`, `llvm-profdata.exe`, and `llvm-cov.exe`.
- Probe with `unitverify_detect_toolchain_environment`. If `cResidualExecutionStrategy.windowsLocalMcdc.available` is false, call `unitverify_prepare_windows_local_mcdc` without `installApproved` and ask the user whether to install LLVM for Windows. Only call it again with `installApproved: true` after explicit user approval.
- Compile template:
  ```powershell
  clang.exe -O0 -g -fprofile-instr-generate -fcoverage-mapping -fcoverage-mcdc `
    -fuse-ld=lld -Wl,/INCREMENTAL:NO `
    generated_residual_harness.c -o generated_residual_harness.exe
  ```
- Run and collect:
  ```powershell
  $env:LLVM_PROFILE_FILE="residual_%p.profraw"
  .\generated_residual_harness.exe
  llvm-profdata.exe merge -sparse residual_*.profraw -o residual.profdata
  llvm-cov.exe export -format=text .\generated_residual_harness.exe --instr-profile=residual.profdata > residual_llvm.json
  llvm-cov.exe report .\generated_residual_harness.exe --instr-profile=residual.profdata > residual_report.txt
  llvm-cov.exe export -format=lcov .\generated_residual_harness.exe --instr-profile=residual.profdata > residual.info
  ```
- Use unique output directories/profile filenames for parallel residual jobs. Do not let two parallel jobs write the same `.profraw`, `.profdata`, `.info`, or HTML directory.
- If Windows local LLVM/lld-link is unavailable and the user does not approve installation, fallback to explicit Docker if requested/available; otherwise use local no-KLEE coverage and report `no_klee_residual_mcdc_fallback`.

Docker path (Windows default):

- Run Windows `ClangParserForWin.exe` `c-coverage` with `runner: "auto"` or `runner: "docker"` so Docker performs source-target filtered KLEE baseline generation with the required regex.
- Preferred CLI command shape:
  ```powershell
  ClangParserForWin.exe --phase c-coverage --runner docker --execution-profile quick `
    --ir <outDir>\ir.json --outdir <outDir> `
    --func_regex "^(?:func1|func2)$" --coverage-engine llvm --mcdc --branch `
    --klee-max-time 60 --klee-max-memory 4096 --klee-parallel <workers>
  ```
- Legacy explicit Docker compatibility command shape:
  ```powershell
  ClangParserForWin.exe --phase docker --ir <outDir>\ir.json --outdir <outDir> `
    --func_regex "^(?:func1|func2)$" --klee-max-time 60 --klee-parallel <workers>
  ```
- The CLI must preserve the actual raw Docker start command in `coverage_manifest.json.runner_commands.docker_run_command` and `.perfectone/runner_logs/docker/docker_run_command.txt`. The final report must link or print this command so the run can be reproduced.
- If Docker is not installed or the prepared image is missing, the report must also show the Docker install/setup commands, for example:
  ```powershell
  winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
  docker pull klee/klee:v3.2
  docker image inspect perfectone/klee-coverage-tools:llvm18-lcov-v1
  ```
- Default options are `--execution-profile quick`, `--klee-max-time 60`, `--klee-max-memory 4096`, `--replay-max-cases-per-function 128`, `--replay-dedup input-hash`, and `--native-replay-timeout 5`.
- KLEE has two separate timers: the internal KLEE exploration limit (`--klee-max-time`, quick default 60 seconds) and an external wall-clock guard (`klee_wall_timeout_sec`, quick default 90 seconds). Treat `exitCode=124` as a bounded KLEE partial timeout, not as a reason to wait for the full coverage child timeout.
- Docker KLEE must run source-target functions in parallel where the CLI supports `--klee-parallel`. Do not run unfiltered Docker coverage.
- Windows local LLVM/lld-link residual native replay and coverage aggregation should run in parallel after the Docker baseline, using disjoint generated harness/profile/artifact directories.
- WSL is not a supported runner option in this plugin path. If a request supplies `runner: "wsl"`, `--wsl-distro`, or `--wsl-path-mode`, report it as disabled and continue only after the request is changed to Docker/local/noop.
- Enable LLVM coverage, branch coverage, and MC/DC.
- Preserve LCOV, HTML coverage, manifest, KLEE testcase, profraw/profdata, logs, and command/status JSON under runner-neutral paths such as `.perfectone/runner_logs/docker`.
- On Docker MC/DC, use the prepared LLVM 18 coverage tools (`/usr/bin/clang-18`, `/usr/bin/llvm-cov-18`, `/usr/bin/llvm-profdata-18`). Do not pass plain `clang`, `llvm-cov`, or `llvm-profdata` through `coverageOptions`; MCP must fail fast instead of silently falling back to clang-16 or mismatched LLVM tools.
- The coding agent, not MCP, chooses optional C exploration parameters after reading the target source. If deeper structure exploration is useful, pass `coverageOptions` explicitly to `perfectone_run_filtered_c_coverage`.
- Optional `coverageOptions` supported by MCP are `heterogeneous`/`hetero`, `structDepth`, `pointerArraySize`, `arrayMaxDims`, and `famSize`. Do not pass `pointerDepth`; PerfectOne CLI accepts it only as deprecated and ignored.
- `structDepth` has a security maximum of 5. If the coding agent chooses a larger value, MCP clamps it to 5 and the report must show the clamp. Do not auto-fill `pointerArraySize`, `arrayMaxDims`, or `famSize`; leave PerfectOne CLI defaults unless the coding agent has a source-grounded reason.
- Preserve LCOV, HTML coverage, manifest, KLEE testcase, profraw/profdata, logs, and command/status JSON. Keep legacy `.perfectone/docker_logs` output for compatibility.
- Record Docker discovered function count and whether KLEE completed.
- If a local/native follow-up is attempted after a Docker coverage attempt, keep the Docker evidence intact. Use a separate report/outDir or the MCP overwrite guard; do not let a failed local replay replace the Docker report as the apparent final result.

Local Linux/macOS native path:

- Use `clang -O0 -g -fprofile-instr-generate -fcoverage-mapping`.
- Add `-fcoverage-mcdc` when the installed clang supports it.
- Run the generated tests/harnesses with `LLVM_PROFILE_FILE`.
- Merge profraw with `llvm-profdata merge -sparse`.
- Report with `llvm-cov export/report/show` and produce LCOV/HTML when available.
- If local MC/DC is impossible, state the exact reason and continue only after a concrete runner blocker is reported or the user explicitly selects another runner such as Docker.

Embedded path:

- Require chip/board, target OS or RTOS, compiler path or prefix, sysroot, startup object, linker script, include/library roots, defines, and compile/link flags.
- Prefer `compile_commands.json` or a CMake toolchain file. If neither exists, report `target_toolchain_context_required` and return the setup prompt instead of running coverage.

## Coding Agent Residual Fill

- Residual means every source-target function whose function, line, branch, or MC/DC coverage is below the 100% goal after PerfectOne filtered KLEE coverage.
- Do not use file-specific historical best coverage as an acceptance gate. The C coverage goal is 100% for every requested source file and every reported metric.
- `needs_coding_agent_residual` is not a final result. If the MCP result has `completionBlocked: true`, `finalAnswerAllowed: false`, `nextRequiredAction: "execute_coding_agent_residual_repair_loop"`, `codingAgentResidualActionRequired.required`, or `codingAgentResidualRepairPlan.executionRequired`, the active coding agent must continue working immediately.
- Do not answer the user with only the PerfectOne baseline numbers while `Coding Agent Applied Cumulative` is `pending` or `Coding Agent Increase` is `+pending`. Those values mean the required residual repair has not been executed yet.
- A function missing from PerfectOne/Docker discovery, such as `TD_main_0_0`, is one residual case. It must not cause the coding agent to skip the other functions that have partial line/branch/MC/DC coverage.
- Do not replace the entire C path with a fast harness-only run.
- Repair generated harnesses, stubs, fixtures, include flags, or local testcases in the working copy as needed.
- After PerfectOne filtered KLEE/MC/DC completes, inspect `coverage_manifest.json`, `coverage_input_file.info`, per-function coverage JSON, and HTML summaries. Build the coding-agent residual target list from every source-target function with uncovered function, line, branch, or MC/DC obligations, not only from functions missing in PerfectOne reports.
- If `perfectone_run_filtered_c_coverage` returns `needs_coding_agent_residual`, `codingAgentResidualRepairPlan.executionRequired`, or a `codingPlatformPrompt`, execute that coding-agent residual repair plan before producing the final answer. Do not treat the MCP call itself as the retry loop.
- The coding agent must actively improve residual coverage after the PerfectOne baseline. For each residual target function, run an iterative repair loop that directly edits or adds generated harnesses, fixtures, stubs, or testcase inputs, then recompiles/replays and remeasures coverage. Do not modify the user's original C source just to raise coverage.
- The first action after `needs_coding_agent_residual` should be local file/shell work, not another summary: create or update a generated residual harness under the run output directory, compile it with an available local coverage toolchain such as GCC/gcov or LLVM coverage, execute it, inspect uncovered lines/branches, and repeat targeted generated-artifact edits.
- A single residual harness attempt is not enough when it increases coverage but the 100% goal is still unmet. If an attempt improves function/line/branch/MC/DC coverage and any requested metric remains below 100%, immediately run the next coding-agent residual attempt.
- Aggregate residual attempts count only when they are actual coverage-growth harness/testcase changes followed by compile/replay/remeasure. A crash-only probe such as `TD_main_0_0` does not consume or replace a coverage-growth retry attempt for the other residual targets.
- If aggregate residual coverage improves and the 100% goal remains unmet, continue aggregate attempts until attempt 5 unless a subsequent attempt shows no coverage increase and all remaining gaps are classified with evidence. Do not stop after attempt 1, 2, or 3 merely because the current uncovered lines look explainable.
- Do not begin residual repair by searching old run directories, old residual harnesses, or prior testcases for a finished answer. Prior artifacts may be used only as comparison evidence after a fresh current-run residual harness/testcase update has been made and remeasured.
- If existing PerfectOne KLEE/native testcase files are reused, they must be copied or referenced from the current run and treated as baseline inputs. They do not satisfy the coding-agent residual attempt requirement unless the agent adds or modifies generated verification artifacts and shows before/after coverage.
- The residual loop is function-scoped and coding-agent-owned. Docker/local KLEE reruns do not count as coding-agent residual attempts.
- For each residual target function, the coding agent must run the residual repair loop up to 5 attempts to improve coverage. Each attempt must change a generated harness, fixture, stub, or testcase input and then recompile/replay/remeasure.
- Stop before the 5th attempt only when the requested metrics reach the 100% goal, or when a coding-agent attempt shows no coverage increase and the remaining gap is also classified with evidence as max-coverage, infeasible, crash-risk, or toolchain-blocked. No-improvement alone is not enough to stop; it needs the gap classification.
- Do not spend the 5-attempt budget on global reruns that do not target a specific uncovered function or branch. Each attempt must name the target function, intended gap, changed generated artifact, replay command, before/after coverage, and stop reason.
- Record residual attempt history as JSON at `mcp_reports/coding_agent_residual_attempt_history.json` before final reporting. The file must contain either `finalCoverageGoalReached: true` or per-function attempt records showing 5 attempts or a justified stop reason such as `max-coverage`, `infeasible`, `crash-risk`, or `toolchain-blocked`.
- After writing attempt history, call `perfectone_validate_c_final_evidence` again. The final answer is allowed only when that tool returns `status: "passed"`.
- If the gate returns `aggregate_residual_attempts_below_required`, continue the generated-artifact retry loop. Do not replace this with a standalone summary HTML.
- Keep initial artifact generation time separate from KLEE/replay time and coding-agent residual time.

## Coding Agent Test Augmentation

- This step is mandatory after PerfectOne filtered KLEE/MC/DC. `needs_coding_agent_augmentation`, `codingAgentTestAugmentationPlan.executionRequired`, or `codingAgentTestAugmentationActionRequired.required` means the active coding agent must continue and must not produce the final verification answer yet.
- Coverage-growth augmentation may reuse the residual repair loop, but it must still be reported as a testcase category with before/after coverage and replay evidence.
- Boundary-value and equivalence-partition augmentation are required even when the user only supplied code and no specification.
- UB corner-case augmentation is conditional. If source review finds plausible UB risk, create generated harness/fixture/testcase inputs that reproduce or safely probe the risk. If a case triggers segfault, sanitizer/runtime failure, memory error, overflow risk, or undefined-behavior suspicion, record the error type, input values, replay command, log path, and root-cause analysis. If no plausible risk exists, report `not_applicable` or `not_generated` with the review reason.
- AB corner-case augmentation is conditional. If source/spec review finds plausible abnormal behavior risk, create generated harness/fixture/testcase inputs that probe invalid mode/state, error return, exception, timeout, resource exhaustion, or unsupported input format. If no plausible risk exists, report `not_applicable` or `not_generated` with the review reason.
- Specification-driven augmentation applies when `unitDesignArtifacts` include requirements, manual testcases, decision tables, state models, boundary values, or equivalence partitions. Execute applicable decision-table, state-transition, boundary-value, and equivalence-partition testcases after the PerfectOne baseline, and record the application reason for each technique.
- Do not modify the user's original `.c` file to add these tests. Use generated harnesses, fixtures, stubs, testcase inputs, or separate candidate artifacts under the run output directory.

## Report Requirements

Final C reports must include:

- MCP status and whether `coverage_unmet` was interpreted as artifact generation complete.
- Whether previous results were found, whether they were reused, and the selected previous/new `outDir`. Default must be reported as new run unless the user explicitly chose reuse.
- Docker/local execution status and whether WSL was disabled for this run.
- Execution mode (`docker`, `native`, `noop`, or blocker), runner, runner policy, and Docker readiness/selection status.
- Docker install/setup commands when Docker is missing or the prepared image is not ready.
- The actual Docker execution command: CLI command, raw `docker run ...` command, Docker exec template or representative `docker exec ... bash -lc ...` command, and the command log path.
- KLEE execution status.
- MC/DC measurement status and numeric value when available.
- Candidate counts: source target functions, MCP functionReports, Docker discovered functions when Docker is explicitly selected.
- Explicit failure reason when header/system functions enter runner coverage.
- Line, branch, function, and MC/DC numbers.
- LCOV, HTML, manifest, logs, KLEE testcase, and residual artifact paths.
- Coding-agent residual scope, including source targets missing from MCP functionReports and every source-target function with coverage below the 100% goal.
- Coding-agent residual MC/DC strategy: Windows local LLVM/lld-link availability, install approval status when missing, fallback path used, and residual job parallelism.
- Coding-agent residual retry evidence: target function, attempt count, before coverage, after coverage, coverage delta, best coverage, changed generated artifacts, replay command, and stop reason. If attempt 1 increased coverage but the final cumulative coverage is still below 100%, the report is incomplete unless attempts 2-5 or a later no-increase/max-coverage classification are shown.
- PerfectOne Coverage, Coding Agent Applied Cumulative coverage, and Coding Agent Increase as `+N%` or `+pending`.
- Coding Agent additional testcase categories: coverage growth, boundary value, equivalence partition, UB corner case, AB corner case, and specification-derived manual/decision table/state transition when applicable.
- For every additional testcase: design method, application reason, input values, expected/oracle, actual result, pass/fail/mismatch classification, replay command, artifact path, and coverage impact.
- For UB cases: error type, root-cause analysis, triggering input, replay/log paths, and whether the case was executed or marked `not_applicable`.
- For AB cases: abnormal behavior type, root-cause analysis, triggering input, replay/log paths, and whether the case was executed or marked `not_applicable`.
- Any coding-agent-selected C exploration options, including heterogeneous mode, struct depth clamp, pointer array size, array max dimensions, and FAM size.
- Initial generation time, KLEE/replay time, and coding-agent residual time as separate values.
- Function testcase I/O page linked from the main HTML: input values, decoded parameter/global candidates when available, stdout/stderr, exit code, expected/oracle, actual, replay command, artifact path, and coverage impact.
- Source-derived Markdown design document linked from the main HTML.
- UB/ASAN interpretation page linked from the main HTML with easy root-cause wording, triggering input, source/log paths, and replay command.
- Coverage limit page linked from the main HTML with unreachable, crash-risk, toolchain-blocked, oracle-missing, max-coverage, and remaining 100% goal gaps separated.
- Docker/local performance note: Docker image reuse status, Docker KLEE parallelism, Windows local residual parallelism, testcase count, replay cap, dedup mode, native replay timeout, and any Docker/local blocker.

## Docker-First Performance Policy

- WSL is disabled in this plugin path because artifact synchronization and host/guest process boundaries made the C coverage workflow too slow for interactive use.
- Docker owns KLEE execution. Reuse an already prepared Docker image during quick/full verification; image pull/build/preparation belongs only to setup or explicit operations requests.
- Docker KLEE must be source-target filtered and parallelized. Do not run unfiltered Docker coverage over headers/system symbols.
- Windows local LLVM/lld-link owns coding-agent residual native replay and coverage aggregation. Run residual harnesses in parallel when their generated source, profile, LCOV, and HTML outputs are disjoint.
- Report Docker KLEE timing separately from Windows local residual timing so users can see whether the bottleneck is symbolic exploration, native replay, merge, or residual coverage.

## HTML Report Style

When producing a final verification artifact, write a polished standalone HTML report by default. Keep it professional and scan-friendly: concise executive summary, status chips, metric tiles for coverage and timing, clear tables for function results and diagnostics, links to LCOV/HTML/manifest/log artifacts, and a distinct residual coverage section. Use embedded CSS, responsive layout, restrained colors, readable typography, and no external network assets. Do not replace numeric evidence with prose; the HTML must preserve exact coverage values, command outcomes, artifact paths, and blocker reasons.

## Rules

- Do not create a second autonomous agent for C verification; the active coding agent should use PerfectOne MCP directly.
- This preview deployment is C-centered. If a plugin/MCP C preview entrypoint receives C++, JS/TS, Rust, Python, Go, Java, C#, Ruby, or another non-C language, return or report `non_c_temporarily_disabled`. Do not edit the `general-unit-verify` skill implementation as part of this C preview workflow.
- Do not install packages, build toolchains, build PerfectOne CLI binaries, or run environment setup scripts as part of the skill workflow. Those are external setup/operations tasks; the skill may only report the exact missing prerequisite and the intended runner path.
- Treat PerfectOne CLI as the C authority for IR, split, stub, harness, KLEE, and MC/DC evidence.
- Keep the active coding agent/Coding Platform as the owner of residual repair, generated harness fixes, local compilation fixes, coverage completion, and final reporting.
- Do not overwrite user-owned source changes.
- Do not ask the user to interpret ordinary build/test errors. Classify the observed failure and either apply a scoped fix or report the real external blocker.
- Do not mark file-only, mock-only, log-only, or harness-only evidence as complete C verification.
