# Decomposition and seven-type classifier

## Atomicity test

Create one candidate per independently reviewable claim. Split when either half
could change without changing the other, has different evidence, lifecycle, or
placement, or uses a distinct normative verb. Keep rationale with its decision;
do not split a condition from the behavior it qualifies.

## Classifier

| Type | Positive test | Negative test |
|---|---|---|
| intent | states an outcome/purpose; “we want onboarding to work offline” | chosen implementation is a decision |
| decision | selects among plausible alternatives; “use a local transactional store for runtime truth” | mandatory external boundary is a constraint |
| constraint | must/must-not limit independent of implementation preference | an observable interface shape is a contract |
| contract | names caller/provider behavior, data, error, timing or compatibility promise | internal repeated style is a convention |
| convention | repeatable team practice whose consistency is the value | one-time migration is a change |
| context | durable background/observable fact needed for interpretation | desired future outcome is intent |
| change | records a substantive before→after transition and impact | current static behavior without transition is context/contract |

## Ambiguous pairs

- decision vs constraint: “we chose X” is decision; “must support Y” is
  constraint even if it motivates X. Preserve both when both are asserted.
- contract vs constraint: externally observable promise is contract; the limit
  that shapes it is constraint.
- convention vs contract: convention coordinates authors; contract coordinates
  components/consumers and has a breach condition.
- intent vs change: intent names desired destination; change names transition
  actually approved/implemented.
- context vs decision: observed WHAT is context unless selection/rationale is
  authored. Never upgrade observed code into a decision.

When no type passes positively, do not force a draft. Report unclassified
evidence for review.
