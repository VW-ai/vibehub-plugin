# Local App setup

Run from `semantic-runtime/` in an interactive terminal:

```sh
npm run app -- --port 0
```

Open the printed loopback URL. Choose **Connect this browser**, compare its code
with the launcher's code, then type `approve CODE` in that same terminal. The
code is a comparison aid, not a credential. Noninteractive launches cannot
approve. `revoke` disconnects the browser. The terminal must remain open.

The App uses the existing local service lifecycle and default `.local/app`
directory. `--data-dir /absolute/path` selects another local data directory.
`npm start` retains the original bootstrap page; `npm run status -- --port PORT`
checks the running service. Use **Stop App**, Ctrl+C or SIGTERM to stop. Saved
Projects/settings/switches survive; a restart always needs fresh pairing.
Closing a browser tab does not stop the service.

## What the connected App does

1. Enter an explicit absolute folder path and inspect it. If it is not a Git
   folder, separately initialize it. This preserves existing files and does not
   create a commit. Bare repositories cannot be enrolled.
2. Enroll the inspected folder as a Project. The actual Git registry reports
   linked worktrees even outside that folder, local branch refs, unborn/detached
   state and observed unavailable/removed worktrees. Refresh when Git changes.
   There is no disk crawl, remote fetch, branch checkout or GitHub requirement.
3. Configure one of three semantic-judgment routes: OpenRouter
   `typesafe/jev-1.13`, Vercel `typesafe-ai/jev`, or TypeSafe `jev-latest`.
   Optional fallbacks must be selected explicitly. Settings retain the existing
   timeout and attempt limits; saving does not call a model.
4. Replace/remove the selected Project/provider key through the local password
   field. The App does not read a stored key back to the page. On macOS it uses
   the existing app-owned Keychain helper; other platforms have no plaintext
   fallback. A locked or denied secure store leaves ordinary setup available.
5. Explicitly enable or disable each Project. New Projects are disabled.
   Linked worktrees inherit that switch; another Project is independent.

**Configured is unverified.** A saved credential is not a successful model call.
Plugins and subscription Workers are visibly **not connected**. This setup
slice does not collect sessions, run Policy Graph nodes, activate context in a
coding Agent, or execute a Worker. The separate synthetic explorer remains at
`prototype/serve.mjs`; its semantic screens are not mixed into this App.

## Small composition and authority boundary

`LocalAppSetup` composes accepted modules: DomainStore, GitProjectRegistry,
ProjectActivation and ProviderSettings. `startLocalRuntime({setup:true})` serves
allowlisted local assets and typed setup routes. No frontend framework or new
runtime dependency was introduced.

One server-owned tenant/owner and at most 64 opaque Project IDs are sufficient
for this local profile. The control catalog in `setup.sqlite` and each Project's
registry use distinct scopes. They cannot commit atomically together. A
persisted reserved/enrolling/ready/error attempt preserves the allocated Project
ID across failure. Retry and list recovery reconcile an already committed
registry; unstarted Git work requires an explicit retry. Git and user files are
never rolled back. A fresh preview may renew an unstarted base only for the same
recorded folder/common-directory identity. Independent clones stay separate;
selecting another linked worktree reuses the existing Project.

A preview belongs to the paired owner, expires after two minutes and binds the
selected path, physical folder and inspected Git state. Initialize/enroll
consume it once and recheck the base. Refresh and switches use expected-version
CAS. A stale or lost response requires rereading state, not retrying an old
command. Disable remains available without a healthy path or optional provider.
Enabling refreshes the already known enrollment first. Existing activation
history, disabled-period gaps and admission fences remain unchanged.

Pairing uses a random HttpOnly SameSite=Strict session cookie without Max-Age or
Expires. The App never puts capabilities in JavaScript storage or URLs. Cookie
names are per instance because cookies are not port-scoped. Browsers may restore
session cookies; physical absence from browser storage is not guaranteed.
Authority remains in server memory: a pending request expires within two minutes,
and terminal approval exchanges it for a fresh session lasting at most one hour.
Restart, Stop, revoke and terminal loss invalidate that authority even if a browser
retains the cookie. This is a local browser boundary, not isolation from hostile
processes under the same OS account.

Every request checks exact Host and supplied Origin/Fetch Metadata. Mutations
require exact Origin, a setup custom header and bounded typed JSON. Private
requests authenticate before paths/stores are inspected. Server-created narrow
domain credentials are revoked after each synchronous operation; browser input
cannot choose a tenant, principal or permission set.

Provider keys are submitted only to the selected secure-store operation. Their
config key hashes the exact tenant/Project tuple; no ambiguous concatenation.
Setup serializes operations with a bounded queue and rechecks the live owner
and Project before dispatch. The optional `ProviderSettings.beforeDispatch`
callback also runs inside its own queue, immediately before an operation. An
expired queued request cannot begin a secure-store write. Already started OS
operations cannot be recalled; the response is withheld after authority expires.
The UI clears the password after an attempt and on Project/provider changes,
and ignores late results from a previously selected Project.

HTTP errors contain only fixed codes. Config databases contain validated
non-secret settings and opaque secure-store references. There is no read-key,
generic filesystem/SQL/shell, grant-mint or arbitrary model-endpoint API.

## Verification and remaining work

Controller tests use real temporary Git/SQLite and synthetic secure stores:
initialization preservation, nested/symlink paths, external/new/removed worktrees,
independent clones, stale/one-use previews, CAS, failure boundaries and restart,
provider isolation and secret-free responses, queued revocation and repeated
polling without credential exhaustion. Native verification creates, replaces
and removes only a fresh synthetic app-owned Keychain entry with finally cleanup.
It never reads an existing user credential.

```sh
node --test test/app-setup.test.mjs
VIBEHUB_TEST_KEYCHAIN=1 node --test \
  --test-name-pattern='fresh synthetic native app-owned' test/app-setup.test.mjs
```

Actual host plugins, subscription execution and the complete capture → model →
context-delivery workflow remain the original local-App onboarding Ticket's
responsibility. This setup can be tested before that integration is ready.
