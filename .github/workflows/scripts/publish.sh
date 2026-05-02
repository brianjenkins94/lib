#!/usr/bin/env bash

PACKAGES=("$@")

pnpm run publish

FAILURES=0
SUCCESSES=0

for PACKAGE in "${PACKAGES[@]}"; do
  VERSION=$(tar -xOzf "docs/$PACKAGE@latest.tgz" package.json 2>/dev/null | jq --raw-output '.version // empty' || true)
  TAG_NAME="$PACKAGE@$VERSION"

  if [[ -z "$VERSION" ]]; then
    echo "❌ Could not determine TAG_NAME for $PACKAGE (docs/$PACKAGE@latest.tgz missing or has no version)"
    FAILURES=$((FAILURES + 1))
    continue
  fi

  echo "📦 Releasing $TAG_NAME"

  if gh release view "$TAG_NAME" > /dev/null 2>&1; then
    gh release edit "$TAG_NAME" --draft=false
    echo "✅ Release $TAG_NAME marked as published"
    SUCCESSES=$((SUCCESSES + 1))
  else
    echo "⚠️  No draft release found for $TAG_NAME — skipping"
    FAILURES=$((FAILURES + 1))
  fi
done

if [[ $SUCCESSES -eq 0 ]]; then
  echo "❌ No packages were successfully published"
  exit 1
fi

exit 0
