#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: publish-marketplace-branches.sh <archive-directory> <vMAJOR.MINOR.PATCH>" >&2
  exit 2
fi

archive_root="$1"
tag="$2"
if [[ ! "${tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "invalid release tag: ${tag}" >&2
  exit 2
fi
if [ ! -d "${archive_root}" ]; then
  echo "archive directory does not exist: ${archive_root}" >&2
  exit 2
fi

version="${tag#v}"
git config user.name "VibeHub Release Bot"
git config user.email "release-bot@vibehub.local"
publications="${RUNNER_TEMP:-/tmp}/marketplace-publications-${GITHUB_RUN_ID:-local}"
: > "${publications}"

for archive in "${archive_root}"/*.tar.gz; do
  if [ ! -f "${archive}" ]; then
    echo "no marketplace archives found in ${archive_root}" >&2
    exit 1
  fi
  filename="$(basename "${archive}")"
  target="${filename#vibehub-${version}-}"
  target="${target%.tar.gz}"
  case "${target}" in
    darwin-arm64-node24|darwin-x64-node24|linux-arm64-node24|linux-x64-node24) ;;
    *)
      echo "unexpected marketplace target in ${filename}: ${target}" >&2
      exit 1
      ;;
  esac

  worktree="${RUNNER_TEMP:-/tmp}/marketplace-${target}-${GITHUB_RUN_ID:-local}"
  mkdir -p "${worktree}"
  tar -xzf "${archive}" -C "${worktree}"

  index="${RUNNER_TEMP:-/tmp}/index-${target}-${GITHUB_RUN_ID:-local}"
  rm -f "${index}"
  GIT_INDEX_FILE="${index}" git read-tree --empty
  GIT_INDEX_FILE="${index}" GIT_WORK_TREE="${worktree}" git add -A
  tree="$(GIT_INDEX_FILE="${index}" git write-tree)"
  commit="$(
    printf 'release: VibeHub v%s for %s\n' "${version}" "${target}" |
      git commit-tree "${tree}"
  )"

  immutable="marketplace/v${version}/${target}"
  immutable_ref="refs/heads/${immutable}"
  if remote_line="$(git ls-remote origin "${immutable_ref}")" && [ -n "${remote_line}" ]; then
    git fetch --no-tags origin "${immutable_ref}"
    remote_tree="$(git rev-parse FETCH_HEAD^{tree})"
    if [ "${remote_tree}" != "${tree}" ]; then
      echo "immutable marketplace branch already exists with different content: ${immutable}" >&2
      exit 1
    fi
  else
    git push origin "${commit}:${immutable_ref}"
  fi
  printf '%s\t%s\n' "${target}" "${commit}" >> "${publications}"
done

if [ "$(wc -l < "${publications}" | tr -d ' ')" -ne 4 ]; then
  echo "release must contain exactly four marketplace targets" >&2
  exit 1
fi

stable_refspecs=()
while IFS=$'\t' read -r target commit; do
  stable_refspecs+=("+${commit}:refs/heads/marketplace/${target}")
done < "${publications}"

# GitHub applies this multi-ref update as one transaction: either all stable
# platform channels advance or none of them do.
git push --atomic origin "${stable_refspecs[@]}"
