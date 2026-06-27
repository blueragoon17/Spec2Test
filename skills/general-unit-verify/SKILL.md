---
name: general-unit-verify
description: Use when the user asks Codex to create, run, or improve unit tests or coverage for non-C languages. Do not use PerfectOne MCP for non-C projects unless the user explicitly asks for a C/PerfectOne workflow.
---

# General Unit Verify

## AgentTest-Compatible Scope

Use this workflow for every non-C language supported by AgentTest, and for C++ unless the user explicitly asks for PerfectOne. AgentTest currently maps:

- C: `.c`, `.h`
- C++: `.cc`, `.cpp`, `.cxx`, `.hpp`
- Python: `.py`
- JavaScript: `.js`, `.jsx`
- TypeScript: `.ts`, `.tsx`
- Go: `.go`
- Java: `.java`
- C#: `.cs`
- Rust: `.rs`
- Ruby: `.rb`

The unit is always a discovered function, method, class/type unit, or explicitly requested symbol inside one target file. Do not expand from the selected symbol to sibling functions, the whole file, or the whole suite unless the user asked for a global run.

## Agent Role Flow

Follow the same responsibility split as AgentTest's PM, Test Designer, Tester, Coverage Collator, QA Reporter, and Global Agent prompts:

1. Global Agent, when the user asks for project/global verification:
   - Discover all supported language units from the input root.
   - Create one work item per target file + symbol.
   - Keep each unit independent, candidate-local, and retryable.
   - For C units only, allow PerfectOne-first baseline/prepass before general repair.
   - Aggregate pass/fail/deferred counts and failure categories in the final report.
2. PM:
   - Select the exact target file and target symbol from user input or discovered inventory.
   - Define acceptance criteria, coverage goal, coverage basis, out-of-scope items, and assumptions.
   - Default goal is 100% branch coverage; use statement coverage only when the language/tool cannot report branch coverage.
   - PM does not write harnesses, stubs, test code, or compiler commands.
3. Test Designer:
   - Design the test matrix for all reachable decisions of the selected symbol.
   - Generate candidate-local harness/stub/fixture/test file plans and compile assumptions.
   - Use project-native frameworks first; when isolated source blocks that path, design a focused candidate harness.
   - For C, reuse PerfectOne split/stub/harness context when available; for every other language, do not call PerfectOne.
4. Tester:
   - Implement candidate-local harnesses, stubs, fixtures, helper scripts, and coverage summary generation.
   - Provide executable build/test/coverage commands, not inspection-only commands.
   - If a command fails, classify the observed diagnostic and switch strategy instead of repeating the same command.
   - Produce a candidate-local, non-empty, parseable coverage artifact with `target_id`, `target_file`, `coverage_tool`, `coverage_basis`, `current`, `goal`, `goal_met`, `artifact_path`, and `scope`.
5. Coverage Collator:
   - Normalize the artifact as the source of truth.
   - Reject log-only, file-only, harness-only, mock-only, empty, outside-workspace, or target-mismatched evidence.
6. QA Reporter:
   - Approve only when the normalized coverage is target-scoped, numeric, parseable, and meets the PM goal.
   - On failure, classify as `compile_failure`, `runtime_failure`, `coverage_missing`, `coverage_below_goal`, `target_mismatch`, `test_design_gap`, or `tooling_failure`.
   - Recommend the next retry entrypoint: Test Designer for design gaps or uncovered branches, Tester for command/runtime/toolchain issues, Coverage Collator for parser/normalization issues.

## Workflow

1. Detect the language and existing test runner from repository files.
   - Call `unitverify_detect_toolchain_environment` when the OS, compiler, package manager, coverage runner, or embedded/cross target context is unclear.
   - If tools are missing, include the returned setup prompt in the working notes and final blocker instead of asking the user to infer the environment.
   - If `unit-design-verify` artifacts are present, use them as the language-independent test design source of truth.
   - Convert manual testcases, decision tables, state transitions, boundary values, equivalence partitions, assertions, and oracles into the native test framework for the detected language.
   - Keep `specified`, `inferred`, `missing`, `needs_review`, `approved`, and `rejected` status visible in the final report.
2. Use the native ecosystem first:
   - Python: `pytest` with `coverage.py`
   - JavaScript or TypeScript: `npm test`, Jest, Vitest, or existing package scripts
   - Go: `go test ./... -cover`
   - Java or Kotlin: Maven/Gradle test tasks with JaCoCo when present
   - C#: `dotnet test` with existing coverage settings or coverlet
   - Rust: `cargo test` with the repository's coverage tool, or `cargo llvm-cov` when already available or easy to install
   - Ruby: existing RSpec/Minitest commands with SimpleCov when present
   - Embedded or cross targets: require the target compiler, sysroot, linker script/startup object, library roots, and build flags before executing candidate-local tests.
3. Add or update focused unit tests for uncovered behavior.
4. Always perform Coding Agent test augmentation after the native baseline coverage run:
   - Generate and execute coverage-growth testcases for uncovered decisions.
   - Generate and execute boundary-value testcases even when only source code was provided.
   - Generate and execute equivalence-partition testcases even when only source code was provided.
   - Review for UB/safety corner cases such as null/invalid references, bounds errors, overflow, divide-by-zero, invalid state, uninitialized data, or size mismatch; generate and execute these only when plausible for the language and code.
   - If a specification or specification-derived artifact exists, also execute manual testcase seeds, decision-table, state-transition, boundary-value, and equivalence-partition testcases and record why each technique was applied or marked `not_applicable`.
   - Execute abnormal-behavior corner cases only when source/spec review marks them plausible, then report error return, exception, timeout, invalid mode/state, resource-limit, or unsupported-input root cause.
5. Run the smallest meaningful test command first, then broaden if shared behavior changed.
6. When a compiler, linker, test runner, import resolver, package manager, or coverage command fails, inspect the observed diagnostic and make the smallest local repair that keeps the requested function or method scope valid. Prefer test edits, fixtures, dependency setup, include/classpath/module path flags, mocks, and existing build configuration before changing user source.
7. If the project-native runner cannot isolate the target, generate a candidate-local harness:
   - Python: temporary `unittest`/`pytest`-style driver plus `coverage.py json`.
   - JavaScript/TypeScript: `node --test`, project scripts, or compiled JS harness with `c8`/`nyc`; compile TS with `tsc` when needed.
   - Go: `_test.go` file in a candidate copy/module or project test package, then `go test -coverprofile`.
   - Java: `javac`/`java` harness or project JUnit/Jacoco path when present.
   - C#: temporary test project or project `dotnet test`/coverlet path.
   - Rust: `cargo test`/`cargo llvm-cov`, or a focused test module when a crate is present.
   - Ruby: Ruby stdlib `Coverage` or project RSpec/Minitest/SimpleCov path.
   - C++: candidate-local compile harness with `g++/gcov`, `clang++/llvm-cov`, or project build system; include/link context must be inferred before declaring a blocker.
8. Re-run the native command after each repair until the target function or method is covered, or until a real external blocker remains.
9. Report function or method-level coverage status and remaining gaps.

## Unit Design Artifact Handoff

When a specification or manual test design exists, consume these common artifacts before writing language-specific tests:

- `unitverify.spec-analysis.v1`: requirements, target units, inputs, outputs, states, constraints, and evidence.
- `unitverify.test-design.v1`: manual testcases, decision table rows, state coverage rows, boundary values, and equivalence partitions.
- `unitverify.assertion.v1`: preconditions, postconditions, invariants, runtime assertions, and safety properties.
- `unitverify.oracle.v1`: expected return values, outputs, state changes, side effects, tolerance, and comparator.
- `unitverify.traceability.v1`: requirement-to-design-to-test-to-coverage links.
- `unitverify.review.v1`: approval/rejection/review state.

If the user has provided source code but no useful specification, use `unitverify_extract_design_from_source` to create source-derived draft artifacts before generating native tests. Keep those artifacts as `inferred`, `needs_review`, or `missing` until the user approves them. Do not call PerfectOne for this source-derived flow unless the target is C and the C Skill is active.

Source-only artifacts must still drive execution of coverage-growth, boundary-value, and equivalence-partition tests. UB and AB corner-case rows are conditional: execute them only when source/spec review indicates plausible risk, and record the error type, triggering input, replay command, logs, and root-cause analysis if a failure or crash occurs.

For C++ source-derived design, prefer the extractor's compiler AST mode when Clang can parse the target. Provide include paths, defines, and standard flags through `compileArgs` or `environment.compileArgs` when the project needs them. If Clang AST fails, continue with lightweight extraction and report the fallback.

For Python, Go, Java, Ruby, JS, and TS, prefer parser-backed source-derived extraction. For Rust and C#, accept lightweight extraction unless the dedicated `syn` or Roslyn helper has been installed in the plugin runtime.

For non-C languages, do not call PerfectOne to process these artifacts. Generate candidate-local tests in the native framework and use `unitverify_compare_expected_values` only for deterministic expected/actual comparison when the native runner output has been normalized.

Expected-value mismatch is separate from coverage failure. A target can have measured coverage and still fail oracle comparison.

## Rules

- Do not call PerfectOne MCP for non-C projects by default.
- Do not call PerfectOne MCP for default C++ projects. Use it for C++ only when the user explicitly asks for PerfectOne.
- Do not auto-install compilers or package managers. Diagnose missing OS/language tooling and produce an exact setup prompt or blocker.
- Prefer existing repository test conventions over adding new frameworks.
- Keep the Coding Platform as the owner of test design, local execution, and final judgment.
- If a single C++ file cannot compile because headers or libraries are missing, first try a candidate-local harness around callable helper units and infer include/library context from nearby project files, build artifacts, and known dependency roots. Mark the requested scope as `target_scope_unverified` only after a harness/build attempt proves that required implementation objects or external libraries are unavailable.
- Do not ask the user to interpret ordinary build/test errors. Classify the observed failure, apply a scoped fix inside the Coding Platform, and iterate with the native toolchain for the detected language.
- Do not approve file-only coverage, mock-only checks, or log-only execution as function-level coverage.
- If coverage cannot be attributed to the requested function or method scope, report `target_scope_unverified`.
- Keep tests deterministic and avoid network dependencies unless the project already uses them.
- Preserve user changes and unrelated generated files.
- Production source is read-only for AgentTest-style verification. Candidate harnesses, stubs, fixtures, scripts, and coverage summaries must stay in the candidate/output workspace.
- Do not finish with only the native baseline coverage. The final report must include the additional Coding Agent testcase categories, technique application reasons, inputs, expected/oracle values, actual results, replay commands, artifact paths, and cumulative coverage increase.

## Output

When producing a final verification artifact, write a polished standalone HTML report by default. Keep it professional and scan-friendly: concise executive summary, status chips, metric tiles for coverage and timing, clear tables for target results and diagnostics, links to coverage artifacts/logs, and a distinct remaining-gaps section. Use embedded CSS, responsive layout, restrained colors, readable typography, and no external network assets. Do not replace numeric evidence with prose; the HTML must preserve exact coverage values, command outcomes, artifact paths, and blocker reasons.

Summarize:

- detected language and test runner
- selected target file and target symbol
- candidate harness/test files generated
- commands run
- tests added or changed
- coverage-growth, boundary-value, equivalence-partition, UB corner-case, and specification-driven testcase results
- technique application reasons and `not_applicable` reasons
- UB error type and root-cause analysis when applicable
- function or method-level coverage result, or reason coverage could not be measured
- normalized coverage artifact path and QA verdict
