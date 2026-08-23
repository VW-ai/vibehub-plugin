# VibeHub public site

Production: [vibehub.team](https://vibehub.team)

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

It owns the exact-source Cloudflare Pages deployment, custom-domain guardrails, production
verification, rollback, and VibeHub Evidence handoff. Run the complete local
preflight before publishing:

```bash
npm run release:preflight
```

After deployment, verify the canonical site mechanically:

```bash
npm run release:verify
npm run release:verify-redirects
```

The site uses Next-compatible static export through vinext. The deployable
artifact is `dist/client`, uploaded directly to the existing Cloudflare Pages
project `vibehub-website-v1`:

```bash
npm run release:deploy
```

The deploy command accepts only a clean committed source state and attaches its
full Git commit to the Pages deployment. Credentials, OAuth state, DNS
validation values, certificate state, and Wrangler logs never belong in Git.

`https://vibehub.team` is the canonical production URL. `vibehub.icu`,
`vibehub.systems`, and every `www` hostname are redirect-only; the release
check requires a permanent redirect that preserves path and query. Routine
releases reuse these active bindings and do not edit DNS.
