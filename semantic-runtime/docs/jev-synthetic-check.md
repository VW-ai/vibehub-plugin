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

Run `npm run check:jev:synthetic -- edge` for eight additional cases: failed
acceptance evidence, a retracted decision, exact association to multiple targets,
unrelated targets, cancelled work and a quoted untrusted instruction. Expectations
also compare exact target IDs where relevant; a merely positive answer is not
enough to pass a multiple-target case.

`latency_ms` measures the whole case, including pacing and retries;
`successful_attempt_ms` measures the successful adapter request, including SDK
and network overhead. It is not server-only inference latency.

## Persisted input check

`npm run check:jev:ingress` runs the same eight edge cases through the actual
local intake module before calling JEV. It creates a temporary synthetic Git
Project and SQLite store, enrolls and enables them, registers a synthetic source,
and persists each approved text snapshot. It closes and reopens the store,
retries the observations to check stable receipts, then reads and verifies the
authorized snapshot bytes before sending their text to the model. It never
opens an existing project, host session or trace.

The smoke's snapshot policy accepts only the eight checked-in synthetic texts.
It is not a production sanitizer. Only text, fixed event type/timestamp, the
semantic question and visible synthetic target IDs/text reach the Judge. Local
ingress/source IDs, catalog, ACL, provenance, payload digests and labels remain
local. Model calls happen outside SQLite transactions.
The temporary store is removed on normal completion or a caught failure.

This command uses the same explicit TypeSafe origin, pacing, retry and deadline
limits. Unlike the original route check, its exit status fails for either a
transport failure or a semantic mismatch. Its report includes intake/reopen/
deduplication/materialization counts. Pending ingress intents remain pending:
the smoke does not execute the production Policy consumer, deliver context to
a host, or claim semantic processing is complete.

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

The [edge report](measurements/jev-edge-20260922.json) records a second actual
eight-request run: 8 completed and matched (including exact target associations),
no retries or observed rate limits, 226–555 ms including 2271 ms accumulated
pacing wait. This one quoted-instruction example does not establish resistance
to prompt injection; authorization still depends on deterministic checks.

A [third run with separate timing](measurements/jev-edge-timing-20260922.json)
verified the explicitly pinned TypeSafe origin and repeated all eight edge cases:
8/8 matched, no retry or rate-limit response. Successful adapter requests took
141–505 ms; whole cases took 308–526 ms, with 1769 ms total pacing. Together the
three runs comprise 24 actual decisions, not a concurrency/load measurement.

The [persisted-input run](measurements/jev-ingress-20260922.json) then exercised
the real temporary intake/reopen/read path: all eight snapshots persisted and
materialized, eight retries recovered their original receipts, and all eight
JEV decisions matched the same edge expectations. The requested `jev-latest`
returned `jev-1.13.0`; successful adapter requests took 124–441 ms, with no retry,
rate limit or transient failure observed and 1974 ms accumulated pacing wait.
All eight ingress intents remained pending, as expected: this was a model-input
composition check, not production Policy processing. These four runs total 32
actual decisions. Repeated examples verify integration but do not increase the
diversity of the quality dataset.

This is route/basic-behavior verification, not a quality benchmark. It cannot
establish calibration, nuanced entity resolution, long-session benefit, or
production rate limits. Keep the existing sanitized Peel audits as separate
historical measurements and add task-specific cases as new Judge nodes land.
