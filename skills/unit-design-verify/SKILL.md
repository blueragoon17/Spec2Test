---
name: unit-design-verify
description: Use when the user provides a specification, requirements document, manual testcases, assertions, expected values, decision tables, state models, boundary values, equivalence partitions, or asks for language-independent unit test design before C/C++/JS/TS/Rust/Python/Go/Java/C#/Ruby verification.
---

# Unit Design Verify

## Scope

Use this skill before language-specific execution when the task needs requirement-derived tests, manual testcase review, assertions, or expected-value comparison. The source of truth is JSON artifact data; HTML is the review UX generated for the user inside the Codex workflow.

This skill is language-independent. Route execution after design:

- C `.c`: use `perfectone-c-unit-verify` and PerfectOne MCP for split/stub/harness, filtered KLEE, MC/DC, and residual repair.
- C++ `.cc/.cpp/.cxx`, JS/TS, Rust, Python, Go, Java, C#, Ruby: use `general-unit-verify` and the project-native test runner. Do not call PerfectOne MCP for non-C unless the user explicitly asks for a C/PerfectOne experiment.

## Artifact Workflow

1. Extract requirements, target units, inputs, outputs, states, constraints, and evidence from the specification or user-provided material.
   - If a specification is provided, call `unitverify_generate_design_from_spec` before execution. It must create manual testcase seeds, decision-table rows, state-transition rows or `not_applicable` evidence, boundary-value rows, equivalence-partition rows, assertions, oracles, review HTML, and a Markdown unit-design document based on the bundled VSCode UnitDesign template.
   - If no specification is provided, or if the specification is too thin, derive a draft unit design from source code with `unitverify_extract_design_from_source`.
   - Treat source-derived requirements, expected values, assertions, and oracles as draft evidence, not authoritative requirements.
2. Create or update these artifacts as needed:
   - `unitverify.spec-analysis.v1`
   - `unitverify.test-design.v1`
   - `unitverify.assertion.v1`
   - `unitverify.oracle.v1`
   - `unitverify.traceability.v1`
   - `unitverify.review.v1`
3. Mark every requirement, testcase, assertion, and oracle with one review state:
   - `specified`: directly stated by the specification.
   - `inferred`: filled by Codex from type, context, common test design rules, or nearby code.
   - `missing`: required for verification but absent.
   - `needs_review`: plausible but not safe to treat as approved.
   - `approved`: accepted by the user or explicitly provided as authoritative.
   - `rejected`: reviewed and excluded.
4. Keep evidence for every non-manual value: source document location, quoted/short paraphrased basis, code symbol, or inference rule.
5. Render a standalone HTML review report with `unitverify_render_review_html` after material updates.

## Source-to-Unit-Design Flow

Use this flow when the user gives source code instead of a specification, or asks to reverse-recommend a unit design from code:

1. Call `unitverify_extract_design_from_source` with the target `projectRoot`, `language`, `sourceFiles`, optional `symbols`, and `.perfectone/unit-design/source-derived` as the default output directory.
   - Before compiler-backed extraction, call `unitverify_detect_toolchain_environment` when compile DB, include paths, OS, or cross-target flags are unclear.
   - For C, keep PerfectOne as the authority. Use source-derived extraction only as draft review input unless PerfectOne artifacts/IR are already available through the C workflow.
   - For C++, prefer compiler AST extraction through Clang when available; use `compileArgs`, compile DB, or `environment.compileArgs` when include paths, defines, target OS, or standard flags are required.
   - For Python, Go, Java, Ruby, JS, and TS, prefer the language parser adapter when available.
   - For Rust and C#, use lightweight extraction until the Rust `syn` helper and C# Roslyn helper are installed.
   - If a parser adapter fails, keep the diagnostic and fall back to lightweight extraction.
2. Review extracted facts:
   - function or method signatures
   - parameter, return, output, and state-like candidates
   - branch, guard, switch, loop, match, and case conditions
   - return or error-path expressions
3. Convert the facts into draft design artifacts:
   - signatures into `unitverify.spec-analysis.v1.units`
   - branch and guard conditions into `unitverify.test-design.v1.decisionTables`
   - comparisons into boundary value and equivalence partition candidates
   - type-derived fallback boundary/equivalence candidates even when the code has no explicit comparison
   - source-only default testcases into `coverage_growth`, `boundary_value`, and `equivalence_partition` testcase rows
   - undefined-behavior risk candidates into `undefined_behavior_corner` testcase rows only when source review finds plausible null/invalid pointer, bounds, overflow, divide-by-zero, uninitialized-read, invalid-state, or size-mismatch risk
   - abnormal-behavior risk candidates into `abnormal_behavior_corner` testcase rows only when source/spec review finds plausible invalid mode/state, error return, exception, timeout, resource exhaustion, or unsupported input format risk
   - guard/range/null checks into assertion candidates
   - literal return or error values into oracle candidates
4. Keep source location evidence on every generated row.
5. Mark source-derived rows as `inferred`, `needs_review`, or `missing`. Never mark them `approved` unless the user explicitly approves them.
6. Render the source-derived HTML review report and surface missing oracle or needs-review rows before execution.

## Test Design Rules

- Code-only default augmentation: when no specification is provided, still generate testcase rows for coverage growth, boundary value, and equivalence partition. These are not optional review notes; they are execution inputs for the language-specific Coding Agent workflow.
- UB corner cases are code-review based, not specification-derived. Generate and execute them only when plausible risk exists, and require the execution report to include the error type, triggering input, replay command, logs, and root-cause analysis if the case fails or crashes.
- AB corner cases are code/spec-review based. Generate and execute them only when plausible abnormal behavior exists, and report invalid mode/state, error return, exception, timeout, resource/resource-limit, unsupported input, or equivalent root cause.
- Decision table testing: derive conditions, actions, rules, expected outcome, and requirement links. Mark incomplete rules as `needs_review`.
- State coverage testing: derive states, transitions, guards, events, and expected next states. Mark missing guards or unspecified invalid transitions as `missing` or `needs_review`.
- Boundary value testing: derive min, max, just-below, just-above, nominal, and invalid values from explicit ranges or type limits. Type-derived limits are `inferred`.
- Equivalence partitioning: derive valid/invalid classes from ranges, enums, formats, nullability, and state constraints.
- Specification-driven execution: when a specification or accessible specification link is provided, review and generate manual testcase seeds, decision table, state transition, boundary value, and equivalence partition testcases. Boundary value and equivalence partition are always generated; if concrete values/classes are absent, create `needs_review` rows. The final report must state why each technique was applied, or why it was `not_applicable`.
- Manual TC input: preserve user-provided values exactly and mark them `specified` or `approved` when the user makes that clear.
- Assertions: separate preconditions, postconditions, invariants, runtime assertions, and safety properties.
- Oracles: record expected return, output parameters, state changes, side effects, tolerance, and comparator.

## MCP Tools

Use deterministic MCP tools for artifact operations:

- `unitverify_validate_artifact`: validate schemaVersion, required arrays, and review states.
- `unitverify_render_review_html`: create the HTML review UX.
- `unitverify_import_manual_tests`: convert manual testcase CSV to `unitverify.test-design.v1`.
- `unitverify_export_manual_tests`: export manual testcases to CSV.
- `unitverify_compare_expected_values`: compare oracle expected values with actual execution results.
- `unitverify_build_traceability_report`: render requirement-to-result traceability.
- `unitverify_generate_design_from_spec`: create specification-derived manual testcase, decision-table, state-transition, boundary-value, equivalence-partition, assertion, oracle, review HTML, and VSCode-template Markdown artifacts.
- `unitverify_extract_design_from_source`: create source-derived draft spec/test/assertion/oracle artifacts.
- `unitverify_detect_toolchain_environment`: detect OS/toolchain setup prompts before compiler-backed extraction or execution.

Do not ask the user to fill low-level JSON by hand. Let Codex update artifacts from natural-language instructions and then validate/render them.

## Execution Handoff

Before running tests, pass approved or review-needed artifacts to the language-specific workflow:

- For C, attach artifact paths through `unitDesignArtifacts` in `perfectone.unitverify.v1`. PerfectOne remains the authority for C IR, split, stub, harness, KLEE, and MC/DC evidence.
- For non-C, generate candidate-local tests from the common artifact and run the native toolchain from `general-unit-verify`.
- Do not treat artifact rendering as execution. The C or non-C skill must execute generated/manual testcases and report pass/fail/mismatch, replay command, artifact path, and coverage impact.

Final execution reports must distinguish:

- coverage result versus expected-value mismatch
- compile/runtime/tooling failure versus missing oracle
- specified/approved evidence versus inferred/draft evidence
- generated testcase coverage versus manual testcase coverage
- coverage-growth, boundary-value, equivalence-partition, UB corner-case, AB corner-case, decision-table, and state-transition testcase categories
