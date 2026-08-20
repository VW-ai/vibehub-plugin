---
name: vibehub-site-release
description: Release, verify, or roll back the VibeHub public website through its existing Sites project and vibehub.icu custom domain. Use when the user asks to publish, deploy, update, verify, or roll back the VibeHub website in site/.
---

# VibeHub Site Release

Keep one exact source commit, one existing Sites project, and one canonical
hostname. Use the available Sites hosting Skill for connector operations; this
Skill adds the VibeHub-specific contract.

## Prepare

1. Work from the exact VibeHub repository and read the active Ticket.
2. Read `site/.openai/hosting.json`. Reuse its `project_id`; never create a
   second project while this ID exists.
3. Run the mechanical preflight from the repository root:

   ```text
   node site/release/scripts/release.mjs preflight
   ```

   It validates the production identity, lints, builds with
   `NEXT_PUBLIC_SITE_URL=https://vibehub.icu`, and runs the rendered contracts.
4. Review the diff and Git status. Deploy only an exact committed source state.
   Push the intended commit before saving the Sites version.

If the user asked only to change or prepare the site, stop after preflight.
Publishing is a production action and needs an explicit publish or deploy
instruction.

## Publish

1. Follow the Sites hosting Skill's existing-project flow. Obtain a short-lived
   source write credential only when necessary, keep it out of URLs and Git
   configuration, and push the exact validated commit with a per-command
   authorization header.
2. Package the site with the Sites hosting helper. Save one version using the
   pushed commit SHA, then deploy that saved version to the existing project's
   resolved access mode. Treat every returned deployment URL as production.
3. Poll the deployment directly until it succeeds or fails. Do not infer
   success from a URL alone.
4. Verify the immutable deployment URL:

   ```text
   node site/release/scripts/release.mjs verify <deployment-url>
   ```

5. Inspect the existing `vibehub.icu` custom-domain status. When it is already
   active, do not touch DNS. If it is missing, pending, failed, or conflicts
   with another resource, perform read-only preflight and require explicit
   human authorization before adding, replacing, or deleting any binding.
   Never commit validation TXT values.
6. Wait for both provider and SSL status to become active, then verify the
   canonical domain:

   ```text
   node site/release/scripts/release.mjs verify https://vibehub.icu
   ```

7. Open the canonical site for the user. Record acceptance-linked VibeHub
   Evidence with the exact source commit, saved Sites version or deployment
   reference, public URL, and successful verification result. Do not record
   credentials, cookies, authorization headers, or DNS validation values.

## Roll back

Rollback is another production mutation. After explicit authorization, deploy
the previous known-successful saved Sites version; do not change DNS. Poll it
to success, verify both its deployment URL and `https://vibehub.icu`, and record
new Evidence describing the rollback.

## Stop conditions

Stop and report when any of these is true:

- the checked-in Sites project ID is missing or different;
- preflight fails, the deploy source is uncommitted, or the pushed SHA differs;
- the current request does not explicitly authorize public deployment;
- an existing DNS or custom-domain binding would be replaced without explicit
  human authorization;
- deployment, provider activation, SSL activation, or production verification
  fails.

Keep credentials and transient provider state outside Git. Do not add a release
database, daemon, global CLI, or second deployment state model.
