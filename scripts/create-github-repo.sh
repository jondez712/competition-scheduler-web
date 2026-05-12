#!/usr/bin/env bash
# After: gh auth login
# Usage: ./scripts/create-github-repo.sh [repo-name]
# Default repo name: competition-scheduler-web

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v gh >/dev/null 2>&1; then
  echo "Install GitHub CLI: https://cli.github.com/ (macOS: brew install gh)"
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Run this first, then try again:"
  echo "  gh auth login"
  exit 1
fi

NAME="${1:-competition-scheduler-web}"

echo "Creating github.com/$(gh api user -q .login)/${NAME} and pushing main…"
gh repo create "$NAME" \
  --public \
  --source=. \
  --remote=origin \
  --push \
  --description "Competition schedule viewer, timeline, draft planner, and Hitchkick export tooling (Next.js)"

echo "Done."
URL=$(gh repo view --json url -q .url 2>/dev/null || true)
if [[ -n "$URL" ]]; then
  echo "Open: $URL"
fi
