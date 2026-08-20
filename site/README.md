# VibeHub public site

The public surface is one content-first causal narrative. It reads through
normal vertical scrolling, while the Ticket cycle advances from the upper left
toward the lower right. Installation remains a first-layer action rather than
another lifecycle stage, and object selection adds optional depth only.

## Develop

```bash
npm ci
npm run dev
```

## Verify the production build

```bash
npm test
```

For the final public build, provide the canonical URL so Open Graph and Twitter
metadata point to the checked-in `public/og.png` preview:

```bash
NEXT_PUBLIC_SITE_URL=https://your-domain.example npm run build
```

The site uses Next-compatible static export through vinext. The deployable
Cloudflare-compatible artifact is written to `dist/`. It requires no D1, R2,
authentication, account state, or runtime product service; `.openai/hosting.json`
keeps both optional bindings disabled.

Deploy the generated artifact through the existing Cloudflare service. Domain,
DNS, and account configuration intentionally remain outside this repository.
