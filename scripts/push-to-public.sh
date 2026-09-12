#!/bin/bash
# Sync local main to the public ElastraX-Public repo
# Usage: bash scripts/push-to-public.sh
set -e

cd "$(dirname "$0")/.."

echo "🔄 Fetching latest from private repo..."
git fetch origin

echo "🔒 Running gitleaks check..."
gitleaks detect --source . --verbose --redact

echo "🚀 Pushing to public repo..."
git push origin-public main

echo "✅ Public repo synced!"
