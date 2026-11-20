#!/bin/bash
# Sync local main to the public ElastraX-Public repo
# Usage: bash scripts/push-to-public.sh
set -e

cd "$(dirname "$0")/.."

echo "🔄 Fetching latest from private repo..."
git fetch origin

# Refuse to publish a checkout that is not exactly what the private remote holds.
# The script used to fetch and then push local `main` regardless: run from a stale
# or divergent checkout it published a different history than origin, silently.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi
local_sha="$(git rev-parse HEAD)"
origin_sha="$(git rev-parse origin/main)"
if [ "$local_sha" != "$origin_sha" ]; then
  echo "❌ Local main ($local_sha) is not origin/main ($origin_sha)." >&2
  echo "   Run 'git pull --ff-only origin main' (or push to origin) first." >&2
  exit 1
fi

echo "🔒 Running gitleaks check..."
gitleaks detect --source . --verbose --redact

echo "🚀 Pushing to public repo..."
git push origin-public main

echo "✅ Public repo synced!"
