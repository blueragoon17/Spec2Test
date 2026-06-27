# Sample 2 Specification

## Units

- `safe_divide(int a, int b, int *out)`
- `clamp_percent(int value)`
- `update_mode(Mode current, Event event, int retry_count)`

## Requirements

REQ-DIV-001: `safe_divide` returns `-2` when `out` is null and must not write an output value.

REQ-DIV-002: `safe_divide` returns `-1` when the divisor is zero and writes `0` to `out`.

REQ-DIV-003: `safe_divide` returns `-3` for `INT_MIN / -1` overflow risk and writes `0` to `out`.

REQ-DIV-004: `safe_divide` returns `0` and writes the integer quotient for normal division.

REQ-CLAMP-001: `clamp_percent` returns `0` for values below `0`.

REQ-CLAMP-002: `clamp_percent` returns `100` for values above `100`.

REQ-CLAMP-003: `clamp_percent` returns the input value for values from `0` through `100`.

REQ-MODE-001: reset always returns `MODE_LOCKED`.

REQ-MODE-002: alarm mode remains alarm except timeout returns locked.

REQ-MODE-003: locked mode returns unlocked for correct PIN.

REQ-MODE-004: locked mode returns alarm for wrong PIN when retry count is at least `3`.

REQ-MODE-005: unlocked mode returns locked on timeout and otherwise remains unlocked.

## Test Design Expectations

Generate manual testcase seeds, decision tables, state-transition tests,
boundary values, equivalence partitions, assertions, and oracles. Boundary
values must include `-1`, `0`, `1`, `99`, `100`, and `101` for `clamp_percent`,
and retry counts `2`, `3`, and `4` for `update_mode`.
