#!/usr/bin/env bash

PACKAGES=("$@")

pnpm run publish

EXIT_CODE=0

for PACKAGE in "${PACKAGES[@]}"; do
  TAG_NAME=$(tar -xOzf "docs/$PACKAGE@latest.tgz" ./package.json 2>/dev/null | jq --raw-output 'select(.version != null and .version != "") | "\(.name)@\(.version)"' || true)

  if [[ -z "$TAG_NAME" ]]; then
    echo "❌ Could not determine TAG_NAME for $PACKAGE (docs/$PACKAGE@latest.tgz missing or has no version)"
    EXIT_CODE=1
    continue
  fi

  echo "📦 Releasing $TAG_NAME"

  if gh release view "$TAG_NAME" > /dev/null 2>&1; then
    gh release edit "$TAG_NAME" --draft=false
    echo "✅ Release $TAG_NAME marked as published"
  else
    echo "⚠️  No draft release found for $TAG_NAME — skipping"
  fi
done

exit $EXIT_CODE
