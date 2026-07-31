# @vw-ai/vibehub-cli

The VibeHub command-line interface for local project context and governed
knowledge workflows.

Run it without a global install:

```bash
npx @vw-ai/vibehub-cli doctor --json
```

Install the private VibeHub release into every detected coding host:

```bash
gh auth login --hostname github.com
npx -y @vw-ai/vibehub-cli@latest host install
```

The installer uses the authenticated GitHub CLI to download and verify the
immutable marketplace release. It never accepts or stores a GitHub token.

Source and documentation: <https://github.com/VW-ai/vibehub-plugin>
