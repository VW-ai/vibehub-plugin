#!/usr/bin/env bash
# Music stems are not in git; pull them from the GitHub Release before mixing.
set -e; cd "$(dirname "$0")"
for f in bach-goldberg-aria.ogg schubert-impromptu-gflat.ogg; do [ -f "$f" ] || curl -sL -o "$f" "https://github.com/VW-ai/vibehub-plugin/releases/download/video-drafts-2026-08-23/$f"; done
ls -la *.ogg
