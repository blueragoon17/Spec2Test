# Sample 1: Complex C Stress

`sample1.c` is copied from the user-provided `input04.c` stress target. It is
intended to exercise complex C parsing, source-target filtering, Docker KLEE
baseline generation, Windows LLVM residual coverage, UB/ASAN interpretation,
and report generation.

This is not the quick smoke sample. Prepare Docker and the coverage image first.

Codex prompt:

```text
Use perfectone-c-unit-verify to verify samples/c-input04-complex/sample1.c.
Use a new run. Run Docker filtered KLEE baseline first, then Windows local LLVM residual coverage.
```

Expected report artifacts include HTML coverage, manifest JSON, testcase I/O,
UB/ASAN interpretation, source-derived design markdown, and coverage limits.
