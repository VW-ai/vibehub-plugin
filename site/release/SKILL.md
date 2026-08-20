---
name: vibehub-site-release
description: Release, verify, or roll back the VibeHub public website through the existing vibehub-website-v1 Cloudflare Pages project and vibehub.icu custom domain. Use when the user asks to publish, deploy, update, verify, or roll back the VibeHub website in site/.
---

# VibeHub Site Release

Keep one exact source commit, one existing Cloudflare Pages project, and one
canonical hostname. The production project is `vibehub-website-v1` in account
`72091e7e079e357ced7f9603c03a926e`; do not create a replacement project.

## Prepare

1. Work from the exact VibeHub repository and read the active Ticket.
2. Run the complete mechanical preflight from the repository root:

   ```text
   node site/release/scripts/release.mjs preflight
   ```

   It validates the Pages identity, lints, builds with
   `NEXT_PUBLIC_SITE_URL=https://vibehub.icu`, and tests the rendered static
   artifact in `site/dist/client`.
3. Review the diff and Git status. Commit and push the intended source before
   deployment. The deployment command refuses a dirty worktree and attaches
   the full current commit hash to Cloudflare.

If the user asked only to change or prepare the site, stop after preflight.
Publishing is a production action and needs an explicit publish or deploy
instruction.

## Publish

1. Inspect the existing Pages project and current production deployments:

   ```text
   cd site
   npx wrangler pages project list
   npx wrangler pages deployment list --project-name vibehub-website-v1
   ```

   Select the authorized Cloudflare account and confirm that the project
   already exists. Never create another Pages or Workers project.
2. From a clean, pushed source commit, deploy the exact preflighted static
   export to the project's `main` production branch:

   ```text
   npm run release:deploy
   ```

   This is a Cloudflare Pages Direct Upload of `dist/client`. Keep OAuth state,
   API tokens, Wrangler logs, and other transient provider state outside Git.
3. Verify the immutable deployment URL returned by Wrangler before any domain
   change:

   ```text
   node site/release/scripts/release.mjs verify <deployment-url>
   ```

4. Bind `vibehub.icu` through the existing Pages project's Custom domains
   flow. Perform read-only conflict inspection first. If the apex still points
   to the temporary origin, replace only the exact preflighted obsolete apex
   records needed by Pages. Retain the Search Console TXT proof, the
   redirect-only `www` record, and every unrelated DNS record. Do not add a
   manual CNAME without the Pages custom-domain association.
5. Wait until the Pages custom domain and certificate are active, then verify:

   ```text
   node site/release/scripts/release.mjs verify https://vibehub.icu
   node site/release/scripts/release.mjs verify-www
   ```

   Both HTTP and HTTPS `www` requests must permanently redirect to the apex
   while preserving the exact path and query.
6. Record acceptance-linked VibeHub Evidence with the source commit, Pages
   project, immutable deployment URL, domain state, and successful checks.
   Never record credentials, cookies, authorization headers, OAuth state, or
   DNS verification values.

## Roll back

Rollback is another production mutation. After explicit authorization, use
Cloudflare Pages deployment rollback for the previous known-successful
production deployment, or redeploy the exact prior committed build if rollback
is unavailable. Do not change DNS. Verify both the immutable deployment and
`https://vibehub.icu`, then record new Evidence describing the rollback.

## Stop conditions

Stop and report when any of these is true:

- the selected account or existing `vibehub-website-v1` project differs;
- preflight fails, the deploy source is uncommitted, or the pushed SHA differs;
- the current request does not explicitly authorize public deployment;
- an unrelated DNS or custom-domain binding would be replaced;
- deployment, provider activation, SSL activation, or production verification
  fails.

Do not add Pages Functions, Workers deployment, a release database, daemon,
global CLI, second hosting project, or second deployment state model.
