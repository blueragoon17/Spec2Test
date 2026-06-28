# Codex Plugin Beta Review Draft

This document is the review package for exposing Spec2Test as a Codex Plugin.
It covers the local Codex app/plugin path, not ChatGPT GPT Store publishing.

Official Codex plugin references:

- [Codex plugins](https://developers.openai.com/codex/plugins)
- [Build Codex plugins](https://developers.openai.com/codex/plugins/build)

## Positioning

Spec2Test is a local Codex Plugin for C unit design and verification. Users
clone the GitHub repository, run the installer to register the plugin with
Codex, and execute verification on their Windows development machine. It
packages:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `mcp-server/`
- `skills/`
- `schemas/`
- `scripts/`
- `samples/`
- Windows beta CLI at `bin/windows/ClangParserForWin.exe`

The Codex Plugin is the recommended execution path. It runs on the user's
machine and orchestrates the local MCP server, PerfectOne CLI, Docker KLEE
baseline, Windows LLVM/lld-link residual MC/DC coverage, and HTML reporting.

## Not Provided

- GitHub Actions verification workflow.
- Hosted SaaS execution.
- ChatGPT Apps SDK server.
- OpenAI GPT Actions.
- WSL runner for this beta.
- Non-C execution path in this beta.

## Local Install Path

```powershell
git clone https://github.com/blueragoon17/Spec2Test.git
cd Spec2Test
powershell -ExecutionPolicy Bypass -File .\install.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

Compatible Codex builds can also use the local marketplace registration created
by the installer:

```powershell
codex plugin marketplace add "$env:USERPROFILE\.codex\plugins\local-marketplaces\perfectone"
codex plugin add perfectone-unit-verify@perfectone-local
```

## Plugin Listing Draft

| Field | Draft |
| --- | --- |
| Name | perfectone-unit-verify |
| Display name | Spec2Test / PerfectOne C Unit Verify |
| Category | Engineering |
| Description | Local C unit design and verification with PerfectOne CLI, Docker KLEE baseline, Windows LLVM residual MC/DC coverage, and HTML evidence reports. |
| Execution | Local only |
| Required local tools | Docker Desktop, prepared KLEE image, LLVM 21+, Node.js 18+ |
| Beta limitations | Embedded unvalidated, non-C disabled, WSL disabled, GitHub Actions not provided |

## Review Checklist

- `README.md` clearly separates GPT app, Codex Plugin, direct CLI, and GitHub
  Actions.
- `.codex-plugin/plugin.json` has correct local execution positioning.
- `.mcp.json` points to the bundled local MCP server.
- `scripts/doctor.ps1` reports Docker, LLVM, CLI, and stale plugin cache status.
- `scripts/setup-windows-c-prereqs.ps1` installs or prepares prerequisites only
  when the user explicitly requests it.
- `scripts/verify-install.ps1` passes locally.
- The repository includes no generated `.perfectone`, `Output`, `.profraw`,
  `.profdata`, `.ktest`, or accidental run artifacts.
- README and docs do not tell users to run verification through GitHub Actions.
- README and docs do not claim ISO 26262, ASPICE, safety certification,
  production readiness, or safety-critical verification completion.

## Owner Review Questions

- Approve the Codex Plugin display name?
- Approve local-only execution wording?
- Approve keeping GitHub Actions out of beta?
- Approve keeping GPT app as guidance only?
- Approve publishing/recommending the local marketplace install path?
