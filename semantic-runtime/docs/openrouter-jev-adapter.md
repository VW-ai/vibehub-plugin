# OpenRouter JEV adapter

`OpenRouterJevJudge` uses the maintained `@openrouter/ai-sdk-provider` **3.1.0**
with the existing AI SDK **7.0.107**. The package's published peer range accepts
AI SDK 7. Both are pinned; no general provider registry or settings UI is added.

It passes `createOpenRouter(...).evaluationModel(model)` to `experimental_evaluate`.
The resulting endpoint is `https://openrouter.ai/api/alpha/decisions`, never the
AI SDK default Gateway. Default model: `typesafe/jev-1.13`; callers can explicitly
select another identifier, but availability is not assumed. The Decisions API
is alpha, so upgrades require the transport fixtures to pass again.

The four existing SemanticJudge families use boolean questions. OpenRouter's
`noul` becomes a probability; >=0.5 selects true, and confidence is the probability
of the selected outcome, not a calibrated quality guarantee. Relational slots map
only to their exact supplied target IDs. Missing, extra, invalid or wrong-type
answers fail. Empty relational target lists make no request. The underlying SDK's
rounded score/probability mapping is tested separately; this adapter does not turn
arbitrary scores into relevance or add unused question types to the semantic core.

Only minimized event text/type/time and visible candidate text/IDs are sent.
Local paths, source metadata and evaluator labels are not forwarded. Adapter
telemetry retains bounded route, cost and token counts (unknown stays null);
the descriptor pins the requested model and each result retains the resolved model;
raw responses, transport headers and credential-bearing errors are not returned.
SDK retries are disabled; callers can use the existing `ResilientJudge` for bounded
429/5xx retries. Each attempt has a default 30-second timeout and respects caller
cancellation. Provider fallback is disabled for this route.

## Synthetic live smoke

Configure `OPENROUTER_API_KEY` **locally** in the process environment, then run:

```sh
cd semantic-runtime
npm run smoke:jev:openrouter
```

If already stored in the ignored `.env.local`, run Node with
`--env-file=.env.local verification/live/jev/smoke-openrouter-jev.mjs`. Do not paste the key into
chat, print it, put it on a command argument or commit it. The smoke uses one
fixed synthetic decision, sends no project trace and reports only the validated
decision, latency and bounded telemetry. It makes one attempt with a deadline.

**Live status: not run.** No OpenRouter credential was requested/read and no real
OpenRouter request was made during implementation. Recorded transport tests verify
adapter compatibility; the app must complete a real synthetic request before
showing this route as verified. Existing Vercel/TypeSafe benchmarks are unchanged.

Run `node --test test/judge/openrouter-jev-judge.test.mjs` to exercise the actual installed
SDK against synthetic HTTP responses, including endpoint/body, boolean and score
semantics, target mapping, metadata, malformed replies, unsupported model/question,
rate limits/retry exhaustion, deadline and cancellation. All these tests are offline.

Primary reference: [OpenRouter's maintained AI SDK provider](https://github.com/OpenRouterTeam/ai-sdk-provider).
Implementation also checked the installed 3.1.0 source and package metadata rather
than assuming a README method alias exists in every released version.
