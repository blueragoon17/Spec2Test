# Sample 2: Basic Control

This sample is a quick C beta validation target. It includes normal behavior,
boundary values, equivalence partitions, state transitions, abnormal behavior,
and UB-risk defensive checks.

Codex prompt:

```text
Use unit-design-verify with samples/c-basic-control/spec.md, then verify samples/c-basic-control/sample2.c with perfectone-c-unit-verify.
Generate manual testcase, decision table, state-transition, boundary, equivalence, assertion, oracle, and HTML reports.
```

Expected report artifacts include the review HTML, source-derived Markdown unit
design document, testcase I/O page, UB/ASAN interpretation page, coverage limit
page, and execution coverage report.
