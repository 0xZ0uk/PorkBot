#!/usr/bin/env bash
#
# Proves push protection is actually enforcing, not merely switched on: it
# builds a throwaway repository, commits one canary shaped like a Slack token,
# and pushes it to a scratch branch. The script succeeds when GitHub refuses the
# push (GH013) and fails when the push lands, in which case it deletes the
# scratch branch and says so.
#
# The canary is generated at run time and never enters this repository: the
# whole point of the check is that the only place a detected secret can exist is
# a refused push.
#
# Usage:
#   scripts/verify-push-protection.sh [<owner/repo>]

set -euo pipefail

repo="0xZ0uk/PorkBot"

for argument in "$@"; do
  if [[ "$argument" == */* ]]; then
    repo="$argument"
  else
    echo "error: unknown argument \"$argument\"." >&2
    exit 2
  fi
done

workdir="$(mktemp -d)"
branch="push-protection-canary-$(date +%s)"
# Deterministic lengths, no pipeline that exits early: a `head` on the end of a
# pipeline makes the upstream process die of SIGPIPE, and `set -o pipefail`
# would then abort this script before it ever pushes.
digits="$(printf '%05d%05d' "$RANDOM" "$RANDOM" | cut -c1-12)"
body="$(openssl rand -hex 16 | cut -c1-20)"
canary="xoxb-${digits}-${body}"
log="$(mktemp)"

cleanup() {
  rm -rf "$workdir" "$log"
}
trap cleanup EXIT

git init -q "$workdir"
git -C "$workdir" remote add origin "https://github.com/${repo}.git"
printf 'push protection canary\n\n%s\n' "$canary" > "$workdir/canary.txt"
git -C "$workdir" add canary.txt
git -C "$workdir" \
  -c user.name="Push protection canary" \
  -c user.email="canary@example.invalid" \
  commit -qm "test: push protection canary"

echo "repository: $repo"
echo "branch:     $branch"
echo "pushing a generated canary; GitHub should refuse it"
echo

if git -C "$workdir" push origin "HEAD:refs/heads/${branch}" 2>"$log"; then
  echo "error: push protection did not block the canary. Deleting the scratch branch." >&2
  git -C "$workdir" push origin --delete "$branch" >/dev/null 2>&1 || true
  exit 1
fi

if ! grep -qE 'GH013|push protection' "$log"; then
  echo "error: the push failed, but not because of push protection:" >&2
  sed 's/^/  /' "$log" >&2
  exit 1
fi

echo "Push protection blocked the canary."
