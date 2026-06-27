# Sample 1 Draft Specification

This sample is a complex C stress target for beta verification.

The verifier should infer source-derived unit design from the C source and
classify inferred requirements, assertions, oracles, and residual coverage gaps
as review-needed unless directly evident from the code.

The coverage target is 100% for measurable function, line, branch, and MC/DC
metrics. Any unreachable, UB-risk, crash-risk, oracle-missing, or toolchain
blocked gap must be reported explicitly.
