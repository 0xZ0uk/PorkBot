#!/usr/bin/env bash
#
# Applies the CI tier checks in .github/workflows/ci.yml as required status
# checks on a protected branch, so "green means mergeable" is enforced by GitHub
# rather than by whoever is reading the pull request.
#
# Usage:
#   scripts/setup-branch-protection.sh [<owner/repo>] [<branch>] [--dry-run]
#
# Why this is a script and not a setting someone ticked once: the required check
# names are the job names in the workflow, and a rename there would silently
# leave merges unguarded. This script refuses to run if a name below no longer
# exists in the workflow, so the two cannot drift apart unnoticed.

set -euo pipefail

repo="0xZ0uk/PorkBot"
branch="main"
dry_run="false"

for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run="true" ;;
    *)
      if [[ "$repo" == "0xZ0uk/PorkBot" && "$argument" == */* ]]; then
        repo="$argument"
      else
        branch="$argument"
      fi
      ;;
  esac
done

workflow=".github/workflows/ci.yml"

if [[ ! -f "$workflow" ]]; then
  echo "error: run this from the repository root ($workflow not found)." >&2
  exit 1
fi

# Every tier job plus the aggregate gate. Every one of these must be green; the
# gate additionally turns "one tier was skipped" into a failure.
checks=(format lint typecheck build quarantine dependencies env posture unit integration e2e desktop gate)

for check in "${checks[@]}"; do
  # Job ids in the workflow are `name: <check>` with the two-space job indent.
  # Matching on the rendered check name (the job's `name:`, not its id) is what
  # GitHub reports in the pull request, which is what a required check matches on.
  if ! grep -qE "^    name: ${check}$" "$workflow"; then
    echo "error: $workflow has no job named \"$check\" (job names are the required checks)." >&2
    exit 1
  fi
done

payload="$(
  node -e '
    const checks = process.argv.slice(1);
    process.stdout.write(
      JSON.stringify({
        required_status_checks: { strict: true, contexts: checks },
        enforce_admins: true,
        // A pull request is required. Zero approvals, because this is a
        // single-operator repository: requiring one would mean nobody could ever
        // merge their own branch.
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: true,
        },
        restrictions: null,
        // An unresolved review thread blocks the merge button: the pr-watch
        // completion gate and this setting are the same rule, enforced in two
        // places.
        required_conversation_resolution: true,
        allow_force_pushes: false,
        allow_deletions: false,
      }),
    );
  ' "${checks[@]}"
)"

echo "repository: $repo"
echo "branch:     $branch"
echo "checks:     ${checks[*]}"
echo

if [[ "$dry_run" == "true" ]]; then
  echo "$payload"
  exit 0
fi

if ! gh api -X PUT "repos/$repo/branches/$branch/protection" --input - <<<"$payload"; then
  cat >&2 <<'MESSAGE'

error: GitHub refused the branch protection update.

On a public repository on the free plan this call succeeds; a 403 means the
token lacks repository admin rights, or the repository cannot protect branches
(for example a private repository on the free plan). Until it is applied,
merging a red pull request is prevented only by convention and the pr-watch
skill rather than by the platform.
MESSAGE
  exit 1
fi

echo "Applied. Required checks on $branch:"
gh api "repos/$repo/branches/$branch/protection" --jq '.required_status_checks.contexts[]' 2>/dev/null ||
  echo "(could not read the protection back)"
