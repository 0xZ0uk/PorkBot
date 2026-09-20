#!/usr/bin/env bash
#
# Applies the GitHub-side security switches a file cannot express: secret
# scanning, push protection and private vulnerability reporting. The repository
# went public with all three off, which meant a contributor (or an agent) could
# push a real credential and nothing would refuse it.
#
# Usage:
#   scripts/setup-repo-security.sh [<owner/repo>] [--dry-run]
#
# `scripts/verify-push-protection.sh` proves the push-protection half by
# attempting a canary push and expecting GitHub to refuse it; this script only
# turns the switches on and reads them back.
#
# GitHub Secret Protection features (validity checks, non-provider patterns) are
# not available on the free plan, so this script requires the two switches that
# are: provider-pattern secret scanning and push protection. The `posture` tier
# is the compensating control for the rest, because it scans the repository's own
# history instead of a provider's surface.

set -euo pipefail

repo="0xZ0uk/PorkBot"
dry_run="false"

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run="true" ;;
    *)
      if [[ "$repo" == "0xZ0uk/PorkBot" && "$argument" == */* ]]; then
        repo="$argument"
      else
        echo "error: unknown argument \"$argument\"." >&2
        exit 2
      fi
      ;;
  esac
done

payload='{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'

echo "repository: $repo"
echo
echo "PATCH repos/$repo"
echo "  $payload"
echo
echo "PUT   repos/$repo/private-vulnerability-reporting"
echo

if [[ "$dry_run" == "true" ]]; then
  exit 0
fi

if ! gh api -X PATCH "repos/$repo" --input - >/dev/null <<<"$payload"; then
  cat >&2 <<'MESSAGE'

error: GitHub refused the secret-scanning update.

Secret scanning and push protection are available on public repositories on the
free plan, so a refusal here usually means the token lacks repository admin
rights (the `repo` scope's `admin` permission on the repository). Fix the token
and re-run; until then nothing refuses a pushed credential.
MESSAGE
  exit 1
fi

gh api -X PUT "repos/$repo/private-vulnerability-reporting" >/dev/null

status="$(gh api "repos/$repo" \
  --jq '[.security_and_analysis.secret_scanning.status, .security_and_analysis.secret_scanning_push_protection.status] | join(",")')"
reporting="$(gh api "repos/$repo/private-vulnerability-reporting" --jq '.enabled')"

if [[ "$status" != "enabled,enabled" ]]; then
  echo "error: expected secret scanning and push protection enabled, got \"$status\"." >&2
  exit 1
fi

if [[ "$reporting" != "true" ]]; then
  echo "error: private vulnerability reporting is not enabled, got \"$reporting\"." >&2
  exit 1
fi

echo "Applied. secret scanning: enabled, push protection: enabled, private vulnerability reporting: enabled."
echo "Verify the enforcement with scripts/verify-push-protection.sh."
