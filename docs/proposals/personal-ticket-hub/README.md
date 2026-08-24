# Personal Ticket Hub contracts

Status: approved implementation authority for
`ticket-personal-hub-contract-and-fixtures`.

This directory defines the Personal Hub MVP data boundary before the separate
application repository exists:

- `contracts/*.schema.json` are strict structural JSON Schemas;
- `contracts/semantic-contract.json` owns cross-record and lifecycle rules
  that JSON Schema cannot express;
- `fixtures/` contains synthetic positive and negative examples;
- `fixtures/manifest.json` binds each example to its expected validation
  result.

JSON documents are used as the canonical fixture serialization because JSON is
a YAML 1.2 subset. Production records retain the `.yaml` filename contract.
No fixture in this directory may contain private project content, credentials,
personal data-root paths, or proprietary attachments.

The future `vibehub-personal` repository adopts these contracts with explicit
provenance. Web, repository handoff, executable VibeHub Tickets, Evidence,
Outcomes, provider APIs, and multi-user semantics are intentionally absent.

Verify the dependency-free contract harness from the plugin repository root:

```sh
node docs/proposals/personal-ticket-hub/scripts/contract-validator.mjs
node --test test/personal-ticket-hub-contract.test.mjs
```
