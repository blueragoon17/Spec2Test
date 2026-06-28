# Spec2Test

Spec2Test is an Open Plugin Beta for C unit design and verification with
Codex-compatible MCP/Skill plugin hosts. It includes the Windows PerfectOne
CLI beta binary, runs source-target filtered Docker KLEE coverage for C, and
uses Windows LLVM/lld-link for residual native replay and MC/DC coverage
evidence.

This beta is C-centered. Embedded targets are not validated yet. Non-C
verification entrypoints are temporarily disabled in this beta plugin
distribution.

## Free GPT Assistant

Spec2Test may also be introduced through a free public GPT named
`PerfectOne Assistant - Embedded C Test Harness Helper`. That GPT is a
documentation, setup, debugging, and learning assistant only. It should direct
users to run the actual CLI/MCP/plugin workflow from this repository on their
own machine.

The public GPT must not be positioned as a safety-certification tool, ISO 26262
or ASPICE compliance tool, production-ready verifier, or automatic completion
path for safety-critical software verification. It should also tell users not
to paste private source code, sensitive logs, credentials, license files,
customer data, or organization-specific paths into the public chat. Use
redacted, minimal, generic excerpts when asking for setup or error-log help.

See `docs/perfectone-assistant-gpt.md` for suggested GPT Store description,
instructions, and safety wording.
See `docs/openai-gpt-store-beta-review.md` for the review checklist before
publishing the free GPT beta.

## Supported Matrix

| Area | Beta status |
| --- | --- |
| Windows C artifact generation | Supported with bundled `bin/windows/ClangParserForWin.exe` |
| Windows C KLEE baseline | Supported through required Docker Desktop |
| Windows C residual MC/DC | Supported with LLVM 21+ and `lld-link.exe` |
| WSL execution | Disabled |
| Embedded C | Unvalidated beta, setup blocker until target context is provided |
| C++, JS/TS, Rust, Python, Go, Java, C#, Ruby | Temporarily disabled |

## Requirements

- Node.js 18 or newer.
- Codex desktop or a compatible MCP/Skill plugin host.
- Windows PerfectOne CLI at `bin/windows/ClangParserForWin.exe` or an override
  through `PERFECTONE_CLI`.
- Docker Desktop with the Linux engine enabled. Docker is mandatory for the
  Windows C KLEE baseline.
- Docker base image `klee/klee:v3.2`.
- Prepared image `perfectone/klee-coverage-tools:llvm18-lcov-v1`.
- Windows LLVM 21 or newer: `clang.exe`, `lld-link.exe`, `llvm-cov.exe`,
  and `llvm-profdata.exe`.

## Install

```powershell
git clone https://github.com/blueragoon17/Spec2Test.git
cd Spec2Test
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

The installer registers the local Codex plugin, MCP server, and skills. It
does not install Docker or LLVM. The Windows CLI beta binary is included under
`bin/windows/ClangParserForWin.exe`.

The installer is compatible with both newer and older Codex plugin CLIs. It
creates a local marketplace root under
`%USERPROFILE%\.codex\plugins\local-marketplaces\perfectone`, links that
marketplace plugin entry back to this repository, and uses `codex plugin add
perfectone-unit-verify@perfectone-local` automatically when the installed Codex
CLI supports it. Older Codex CLIs that only provide `codex plugin marketplace`
fall back to direct `config.toml` registration.

Equivalent marketplace commands for compatible Codex builds:

```powershell
codex plugin marketplace add "$env:USERPROFILE\.codex\plugins\local-marketplaces\perfectone"
codex plugin add perfectone-unit-verify@perfectone-local
```

## Prepare Windows C Environment

Run the setup script only when you want it to install or prepare prerequisites.
Without install flags, use `doctor.ps1` for diagnosis only.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-c-prereqs.ps1 -PrepareDockerImage
```

Optional installation flags:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-c-prereqs.ps1 -InstallDocker
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-c-prereqs.ps1 -InstallLLVM
```

Docker Desktop install command used by the setup script:

```powershell
winget install --id Docker.DockerDesktop -e --source winget --accept-package-agreements --accept-source-agreements
```

LLVM install command used by the setup script:

```powershell
winget install --id LLVM.LLVM -e --source winget --accept-package-agreements --accept-source-agreements
```

## PerfectOne CLI Location

The beta repository includes:

```text
bin/windows/ClangParserForWin.exe
```

To override it, set:

```powershell
$env:PERFECTONE_CLI = "C:\Path\To\ClangParserForWin.exe"
```

Only one current CLI should be used for a run. The doctor reports missing or
ambiguous CLI configuration.

## Direct CLI Usage

You can use the bundled CLI without Codex/MCP when you need a raw PerfectOne
run. Docker Desktop must be installed and running for Windows C KLEE coverage.
If Docker Desktop is not running, the MCP path attempts to start it
automatically; direct CLI usage expects you to start Docker Desktop first.

Check CLI capabilities:

```powershell
.\bin\windows\ClangParserForWin.exe --capabilities --json
```

Typical two-step direct flow:

```powershell
$src = "samples\c-basic-control\sample2.c"
$out = "Output\sample2_direct"
New-Item -ItemType Directory -Force -Path $out | Out-Null

.\bin\windows\ClangParserForWin.exe `
  unit-verify --request .\samples\c-basic-control\perfectone-request.json `
  --output "$out\perfectone_report.json" --json
```

When you already have a generated IR from the artifact phase, run filtered
Docker coverage directly:

```powershell
.\bin\windows\ClangParserForWin.exe --phase c-coverage --runner docker `
  --execution-profile quick `
  --ir "$out\ir.json" `
  --outdir "$out" `
  --func_regex "^(?:safe_divide|clamp_percent|update_mode)$" `
  --coverage-engine llvm --mcdc --branch `
  --klee-max-time 60 --klee-max-memory 4096
```

The MCP/Skill path is preferred because it creates the request JSON, source
function filter, progress polling, residual repair prompts, and final HTML
report automatically.

## Run Sample 1: Complex C Stress

Sample path:

```text
samples/c-input04-complex/sample1.c
```

This is a complex C stress sample with structures, pointers, arrays, function
pointers, and UB-risk paths. It is not the quick smoke sample. Run it after
Docker and the prepared coverage image are ready.

Codex prompt:

```text
Use perfectone-c-unit-verify to verify samples/c-input04-complex/sample1.c.
Use a new run. Run Docker filtered KLEE baseline first, then Windows local LLVM residual coverage.
```

Success is judged against the 100% coverage goal and by whether residual gaps,
UB/ASAN findings, testcase I/O, and coverage limits are reported clearly. This
sample does not use a historical coverage number as the acceptance target.
The 2026-06-28 local beta stress run is summarized in
`docs/input04-beta-e2e-20260628.md`. Treat that result as engineering evidence
for the beta package, not as a coverage guarantee or certification claim.

## Run Sample 2: Basic Control

Sample path:

```text
samples/c-basic-control/sample2.c
```

This sample is intended for quick setup validation. It includes safe division,
range clamping, and a small mode transition function with a specification and
manual testcase seeds.

Codex prompt:

```text
Use unit-design-verify with samples/c-basic-control/spec.md, then verify samples/c-basic-control/sample2.c with perfectone-c-unit-verify.
Generate manual testcase, decision table, state-transition, boundary, equivalence, assertion, oracle, and HTML reports.
```

## Expected Reports

A successful C run should preserve or link:

- MCP status and runner status.
- Docker KLEE baseline status and raw `docker run ...` command.
- Windows local LLVM residual status.
- Function testcase I/O page.
- Source-derived Markdown design document.
- UB/ASAN interpretation page.
- Coverage limit page.
- LCOV, HTML coverage, manifest, logs, KLEE testcase files, and residual
  harness artifacts.

Final reporting is gated by `mcp_reports/final_evidence_gate.json`. When
PerfectOne baseline coverage is below the 100% goal, the
`perfectone_validate_c_final_evidence` MCP tool blocks final reporting until
Coding Agent residual evidence is recorded in
`mcp_reports/coding_agent_residual_attempt_history.json`. A single augmentation
harness is not enough if coverage increased but remains below 100%; residual
repair must continue until either the 100% goal is reached or two consecutive
measured generated-artifact attempts show no coverage increase, with a hard
limit of 10 attempts. When stopping below 100%, every residual target must be
classified with evidence as max-coverage, infeasible, crash-risk, or
toolchain-blocked. When the evidence gate passes, the validator normalizes the
canonical MCP report and removes stale `FINAL_REPORT_BLOCKED.md` markers.

Manual residual history must not rely on hand-entered coverage numbers alone.
Each attempt needs a generated-artifact key and a parseable measurement artifact
key, for example:

```json
{
  "attempt": 1,
  "changedArtifact": "coding_agent_residual/attempt1/residual_attempt1.c",
  "coverageArtifact": "coding_agent_residual/attempt1/residual_attempt1_llvm.json",
  "afterCoverage": {"line": 91.2, "branch": 84.3, "function": 96.7, "mcdc": 42.9}
}
```

If the same aggregate residual attempts explain multiple target gaps, link them
from each target instead of duplicating or omitting the relationship:

```json
{
  "aggregateAttempts": ["...attempt records..."],
  "perFunction": [
    {"function": "func3", "attemptsRef": "aggregate", "stopReason": "max-coverage"},
    {"function": "TD_main_0_0", "attemptsRef": "aggregate", "stopReason": "crash-risk"}
  ]
}
```

## Output Disclaimer

Spec2Test and PerfectOne-generated outputs are beta verification assistance
artifacts, not certified proof of product correctness, safety, security, or
standards compliance. Generated tests, assertions, reports, coverage numbers,
UB/ASAN interpretations, and recommendations must be reviewed and approved by
the user before use.

The repository owner and tool author do not take responsibility or liability
for decisions, defects, losses, certification claims, safety claims, compliance
claims, or production releases based on this tool's outputs. You are
responsible for validating the generated artifacts against your own source
code, requirements, target platform, toolchain, and applicable engineering
process.

## Troubleshooting

- `dockerDesktopLinuxEngine` pipe missing: Docker Desktop is mandatory. Start
  Docker Desktop, or let the MCP execution path attempt automatic startup, then
  rerun `scripts\doctor.ps1`.
- Prepared image missing: run `scripts\setup-windows-c-prereqs.ps1 -PrepareDockerImage`.
- LLVM MC/DC unavailable: install LLVM 21+ and ensure `C:\Program Files\LLVM\bin`
  is on `PATH`.
- WSL requested: this beta disables WSL for the C plugin path.
- Embedded target requested: provide compiler, sysroot, linker script, startup
  objects, defines, include/library paths, and build flags before execution.

## Security and Write Access

The public repository is readable and forkable, but `main` is protected.
Repository changes require owner-controlled review and status checks.

## License and CLI Notice

This repository is published under the Spec2Test Open Plugin Beta License.
PerfectOne CLI binaries and the PerfectOne verification engine are not included
and are licensed separately.
