# Repeatable synthetic JEV check

`npm run check:jev:synthetic` runs eight fixed synthetic cases against the official
TypeSafe route using `TYPESAFE_API_KEY` from the local process environment. It
does not load credentials from a file or Keychain itself. Keep keys local and
never paste or print them. The script sends only the event, question and visible
target text; expected labels stay local. It does not send project traces.

Four existing Judge families each get one positive and one negative case. Calls
are sequential, spaced at least 500 ms, with two attempts for 429/5xx and a
15-second total deadline per case. The safe JSON report distinguishes incomplete
requests from semantic mismatches. Exit failure means a request failed; a mismatch
is visible in `matched` and the per-case report rather than an exception.

## Measurement: 2026-09-22

Real endpoint: `api.typesafe.ai`, requested `jev-latest`, returned `jev-1.13.0`.
Eight requests completed, eight matched the hand-authored synthetic expectations.
No retry, rate-limit or transient-failure response was observed. Per-case total
elapsed time was 335–550 ms, including pacing wait; accumulated pacing wait was
2206 ms. These times are not isolated model latency or a load-test SLO.

The checked-in [safe report](measurements/jev-synthetic-20260922.json) contains no
credential or project trace. The run used the previously authorized TypeSafe
Keychain entry in a private local launcher; its bytes were passed only through
process memory/environment and never surfaced to the conversation or report.
The launcher is outside the repository and is not a product credential solution.

This is route/basic-behavior verification, not a quality benchmark. It cannot
establish calibration, nuanced entity resolution, long-session benefit, or
production rate limits. Keep the existing sanitized Peel audits as separate
historical measurements and add task-specific cases as new Judge nodes land.
