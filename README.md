# Spec2Test

Spec2Test is an Open Plugin Beta for C unit design and verification with
Codex-compatible MCP/Skill plugin hosts. It includes the Windows PerfectOne
CLI beta binary, runs source-target filtered Docker KLEE coverage for C, and
uses Windows LLVM/lld-link for residual native replay and MC/DC coverage
evidence.

This beta is C-centered. Embedded targets are not validated yet. Non-C
verification entrypoints are temporarily disabled in this beta plugin
distribution.

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
