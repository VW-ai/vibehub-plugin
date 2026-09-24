# Local provider settings

This module owns per-Project model API configuration and local credentials. It
does not add a browser form, HTTP endpoint, automatic route failover or Worker
login. The local service will compose it behind its authenticated API.

`ProviderSettings({ filePath, secretStore })` uses an app-owned SQLite file in
the caller's ignored local data directory. One local service owns the settings
writer. Per-instance async mutations are serialized. It persists validated
configuration and opaque credential references; it never persists API keys.
SQLite transactions protect each settings write. Keychain and SQLite are not a
distributed transaction: an interrupted initial save may leave a Keychain entry
before its reference is saved. Retrying or explicitly removing the same Project
and provider safely addresses the same entry. A failed settings write is never
reported as success.

```js
const config = {
  primary: { provider: 'typesafe', model: 'jev-latest', capability: 'semantic-judge-v0' },
  fallbacks: [],
  timeout_ms: 30000,
  max_attempts: 2,
};
await settings.configure(projectId, config);
```

Supported routes are intentionally the existing JEV adapters:

| Provider | Model | Capability |
| --- | --- | --- |
| `openrouter` | `typesafe/jev-1.13` | `semantic-judge-v0` |
| `vercel` | `typesafe-ai/jev` | `semantic-judge-v0` |
| `typesafe` | `jev-latest` | `semantic-judge-v0` |

The capability denotes the existing four boolean semantic-decision families;
it does not claim general text generation, calibrated probabilities or provider
availability. Unknown provider/model/capability/fields fail explicitly. Timeout
is 100–120,000 ms and attempts are 1–3. These settings are inputs for the later
Judge runtime, which must enforce them; saving settings never makes a model call.

`resolveRoute(projectId)` selects the primary. An explicit second provider must
be in that Project's fallback list, with no duplicates or primary reentry.
Authentication errors do not switch routes. There is no implicit Gateway,
process-environment or subscription-credential fallback. Codex/Claude managed
login remains outside this module.

Local-process methods:

- `configure` / `getConfig` / `resolveRoute`: validated non-secret settings.
- `replaceCredential(projectId, provider, secret)`: create or replace the
  Project-specific secure-store entry; caller passes the key only in memory.
- `removeCredential`: remove that entry and its local reference; idempotent.
- `credentialStatus`: only `configured`, `missing` or `error`. Configured means
  the secure-store item exists, not that a model endpoint accepted the key.
- `useCredential(projectId, provider, callback)`: **trusted runtime-only** SDK
  boundary. The callback receives the key in process memory. Do not expose this
  method as a read-key endpoint, return the key from its callback, or send it to
  UI/model input/logs. Callback errors are replaced with bounded codes;
  provider 401/403 becomes `credential_rejected`, not a fallback attempt.

## macOS secure storage

`MacOSSecretStore` uses Security.framework generic-password entries under the
fixed `team.vibehub.semantic-runtime.providers.v0` service and only opaque
`vhcred_...` accounts. Project/provider references are isolated and cannot name
existing user entries. The helper is compiled from the checked-in Swift source
into ignored `.local/keychain/` on first use. macOS Command Line Tools/Swift are
required in this developer profile; a packaged App can later ship that helper.
No native dependency or installer is added now.

Requests arrive over the child's stdin; keys never occur in argv, URLs,
stdout, stderr or environment variables. For internal SDK use only, a read
returns bytes over a separate inherited private pipe (descriptor 3), then the
parent clears its byte buffers. JavaScript strings cannot guarantee erasure
from process memory; this is not a memory-hardening claim. Child environment
does not inherit API credentials. Standard output contains a fixed state only.

Keychain interaction UI is disabled for this background helper. A locked store,
denied access, absent compiler, unsupported OS or helper timeout yields an
explicit error; there is no plaintext fallback or invisible login prompt.
Normal development can continue without a configured provider. The module
never reads existing credentials, environment API keys or CLI OAuth material.

Run the synthetic unit tests normally. The explicit macOS secure-store check
uses a fresh random app-owned account, only synthetic values, validates fresh
instance lookup and replacement, and deletes the entry in `finally`:

```sh
node --test test/judge/provider-settings.test.mjs test/support/macos-secret-store.test.mjs
VIBEHUB_TEST_KEYCHAIN=1 node --test test/support/macos-secret-store.test.mjs
```

The opt-in test is separate from ordinary CI because it touches the OS Keychain.
Live endpoint success belongs to route-specific smoke tests, not settings tests.
