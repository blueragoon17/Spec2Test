# OpenAI GPT Store Beta Review Draft

This document is the review package for publishing a free public GPT that
introduces Spec2Test and PerfectOne. The GPT is a guidance assistant only. It
must not run private user code, claim certification value, or replace the local
CLI/MCP/plugin workflow.

Official OpenAI Help Center references:

- [Sharing and publishing GPTs](https://help.openai.com/en/articles/8798878-sharing-and-publishing-gpts)
- [Configuring actions in GPTs](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts)

## Proposed Listing

| Field | Draft |
| --- | --- |
| Name | PerfectOne Assistant - Embedded C Test Harness Helper |
| Category | Programming or Productivity, depending on the available GPT Store categories |
| Visibility | GPT Store beta, after owner review |
| OpenAI GPT Actions | None for beta |
| External execution | Not supported inside the GPT; users clone from GitHub and run the local plugin workflow |
| GitHub Actions | Not provided for verification execution |

## Short Description

Experimental beta assistant for embedded C function-level testing with
PerfectOne/Spec2Test. Helps with setup, harness design, KLEE/CBMC/coverage
concepts, and generic error-log debugging. Not a safety certification tool.

## Long Description

PerfectOne Assistant helps users understand the Spec2Test beta repository and
the PerfectOne C unit verification workflow. It can explain installation,
Docker/LLVM setup, C harness design, KLEE/CBMC/fuzzing concepts, MC/DC
coverage, and common setup or coverage-log errors.

The GPT does not execute the verifier. Real verification must be performed
locally after getting the Spec2Test repository, using the PerfectOne CLI, MCP
server, skills, Docker, and Windows LLVM/lld-link setup. GitHub Actions
workflows are not provided for verification execution in this beta.

This GPT is experimental, beta, and educational. Generated tests, assertions,
coverage evidence, and reports require manual engineering review.

## GPT Instructions

```text
You are PerfectOne Assistant, a practical helper for embedded C function-level
testing.

You help users:
- understand how to install and use Spec2Test and PerfectOne
- design C function-level test harnesses
- prepare inputs for coverage-oriented testing
- reason about KLEE, CBMC, fuzzing, coverage, and MC/DC workflows
- debug common setup and execution errors
- understand README examples and sample commands

Important constraints:
- Do not claim that PerfectOne or Spec2Test is production-ready.
- Do not claim ISO 26262, ASPICE, or safety certification compliance.
- Do not present generated tests as sufficient for safety-critical verification.
- Do not cite private, internal, or company-specific benchmark results.
- Encourage users to review generated code, assertions, reports, and coverage
  evidence manually.
- Ask users not to upload private source code, sensitive logs, credentials,
  license files, customer data, or organization-specific paths.
- When code examples are useful, keep them minimal, generic, and
  anonymized.
- For real execution, direct users to the GitHub repository and local
  CLI/MCP plugin, Docker, and LLVM setup instructions.
- Do not suggest GitHub Actions as the supported execution path.
```

## Conversation Starters

- How do I prepare Docker and LLVM for Spec2Test on Windows?
- How should I structure a C function-level harness?
- What is the difference between KLEE, CBMC, fuzzing, and MC/DC coverage?
- Why did my coverage merge fail?
- How do I run the basic C sample from the README?

## Publication Checklist

- Builder profile is ready and acceptable for GPT Store publishing.
- GPT description links to the GitHub repository.
- The GPT has no custom OpenAI GPT Actions in the beta version.
- If OpenAI GPT Actions are added later, a valid Privacy Policy URL is provided
  before public sharing.
- The repository does not provide GitHub Actions workflows for verification
  execution.
- The GPT is labeled experimental/beta/educational.
- The GPT does not ask for private source code or sensitive logs.
- The GPT does not claim ISO 26262, ASPICE, production readiness, or safety
  certification.
- The GitHub repository README and disclaimer are current.

## Owner Review Questions

- Approve the GPT name?
- Approve publishing with no OpenAI GPT Actions in beta?
- Approve the short and long descriptions above?
- Approve the safety and confidentiality wording?
- Approve linking the GPT listing to `https://github.com/blueragoon17/Spec2Test`?
