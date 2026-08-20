# VibeHub public site

Production: [vibehub.icu](https://vibehub.icu)

The public surface is one content-first causal narrative. It reads through
normal vertical scrolling, while the Ticket cycle advances from the upper left
toward the lower right. Installation remains a first-layer action rather than
another lifecycle stage, and object selection adds optional depth only.

## Develop

```bash
npm ci
npm run dev
```

## Release

Agents must use the repository-local release Skill:

```text
site/release/SKILL.md
```

It owns the exact-source Sites deployment, custom-domain guardrails, production
verification, rollback, and VibeHub Evidence handoff. Run the complete local
preflight before publishing:

```bash
npm run release:preflight
```

After deployment, verify the canonical site mechanically:

```bash
npm run release:verify
npm run release:verify-www
```

The site uses Next-compatible static export through vinext. The deployable Sites
artifact is written to `dist/`. `.openai/hosting.json` stores only the existing
Sites project ID and its intentionally empty D1/R2 bindings. Credentials, DNS
validation values, live certificate state, and temporary deployment archives
never belong in Git.

`https://vibehub.icu` is the canonical production URL. The `www` hostname is
redirect-only and its release check preserves path and query. Routine releases
reuse these active bindings and do not edit DNS.
