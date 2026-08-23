#!/usr/bin/env bash
# Music stems are DVC-tracked (Cloudflare R2). Pull them before mixing.
set -e; cd "$(dirname "$0")"; ~/.cache/vh-dvc/bin/dvc pull bach-goldberg-aria.ogg.dvc schubert-impromptu-gflat.ogg.dvc; ls -la *.ogg
