# Semantic-aware PR procedure

## Safety invariants

- Work only on a named task or feature branch. Pass every observed
  repository-configured protected branch to the checkpoint adapter.
- Treat the default branch, `main`, `master`, detached HEAD, unresolved
  conflicts, invalid knowledge, and a stale checkpoint receipt as blocked.
- Let the checkpoint adapter preserve unrelated staged and unstaged work.
  Never compensate with broad `git add`, reset, restore, stash, or checkout.
- A checkpoint may aggregate several related spec edits. Do not create a commit
  when the derived semantic digest is unchanged.
- Keep merge, squash, force-push, and branch deletion as separately authorized
  actions. A PR procedure prepares evidence; it does not grant authority.

## Sync and conflict handling

Fetch before claiming current remote state. Compare the branch with the actual
default branch and identify whether the PR is stacked on another unmerged
branch.

| Concurrent semantic change | Handling |
|---|---|
| Different specs | Accept a clean Git merge, then run full validation. |
| Same spec, disjoint fields | Inspect the merged claim and evidence, then validate. |
| Same field | Require an explicit semantic decision. |
| Same next revision identity | Rebase and renumber only with history-rewrite authorization. |
| Lifecycle or replacement disagreement | Require a lifecycle decision; never select by timestamp. |
| Relation change | Re-run endpoint, cycle, and relation-evidence checks. |
| Delete versus amend | Require an explicit retain/deprecate/supersede decision. |

If a clean textual merge fails semantic validation, treat it as a conflict.
If a textual conflict exists, never hide it with an auto-resolution strategy.

## Review brief

Use this shape in the PR body:

```text
Semantic change:
- changed spec identities and lifecycle effects
- new or amended claims, evidence, anchors, relations, and provenance

Code/runtime change:
- implementation boundary and user-visible behavior

Validation:
- exact commands and observed results

Reviewer decisions:
- unresolved same-claim, lifecycle, relation, or deletion choices

Deferred:
- explicitly out-of-scope work
```

Omit an empty section rather than inventing content. Link claims to diff paths,
operation receipts, or test output. Commit hashes are useful evidence but are
not the sole durable identity when a repository may squash a PR.

## Nested use

A domain skill finishes its own analysis and mutations, then delegates these
bounded outputs:

- repository and branch;
- task and actor identities;
- successful mutation receipts;
- domain-specific review decisions and validation commands.

The PR skill owns checkpointing, branch/remote inspection, review packaging,
and requested PR creation/update. The caller retains domain judgment. Return
the PR URL, head commit, validation results, blockers, and remaining reviewer
decisions to the caller.
