# Reporting contracts

Consume only dispatcher envelopes:

```json
{"ok":true,"data":{},"meta":{"operation":"kb.status","repoId":1,"requestId":"...","at":"..."}}
```

or:

```json
{"ok":false,"error":{"code":"...","message":"...","details":{},"nextSafeActions":[]}}
```

Never claim a mutation succeeded unless `ok` is true. Report IDs, states,
request/run/version IDs, defaults, conflicts, unresolved evidence, and the next
explicit review action. Keep evidence excerpts bounded and cite source refs.

Query output must conform to `../contracts/context-packet.schema.json`; ingest,
scope and validation artifacts must conform to their named schemas before use.
