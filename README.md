# Spec2Test

Spec2Test is an Open Plugin Beta for C unit design and verification with
Codex-compatible MCP/Skill plugin hosts. It connects Codex to an externally
provisioned PerfectOne CLI, runs source-target filtered Docker KLEE coverage
for C, and uses Windows LLVM/lld-link for residual native replay and MC/DC
coverage evidence.

This beta is C-centered. Embedded targets are not validated yet. Non-C
verification entrypoints are temporarily disabled in this beta plugin
distribution.

## Supported Matrix

| Area | Beta status |
| --- | --- |
| Windows C artifact generation | Supported with external `ClangParserForWin.exe` |
| Windows C KLEE baseline | Supported through Docker |
| Windows C residual MC/DC | Supported with LLVM 21+ and `lld-link.exe` |
| WSL execution | Disabled |
| Embedded C | Unvalidated beta, setup blocker until target context is provided |
| C++, JS/TS, Rust, Python, Go, Java, C#, Ruby | Temporarily disabled |

## Requirements

- Node.js 18 or newer.
- Codex desktop or a compatible MCP/Skill plugin host.
- A separately provisioned PerfectOne CLI. For Windows C, place it at
  `bin/windows/ClangParserForWin.exe` or set `PERFECTONE_CLI`.
- Docker Desktop with the Linux engine enabled.
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
does not install Docker, LLVM, or PerfectOne CLI binaries.

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

## Provide PerfectOne CLI

This repository does not contain PerfectOne CLI binaries. Provide one of:

```powershell
$env:PERFECTONE_CLI = "C:\Path\To\ClangParserForWin.exe"
```

or copy the binary to:

```text
bin/windows/ClangParserForWin.exe
```

Only one current CLI should be used for a run. The doctor reports missing or
ambiguous CLI configuration.

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

- `dockerDesktopLinuxEngine` pipe missing: start or restart Docker Desktop,
  then rerun `scripts\doctor.ps1`.
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
