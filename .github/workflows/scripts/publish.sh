#!/usr/bin/env bash

PACKAGE="$1"

TAG_NAME=$(jq --raw-output 'select(.version != null and .version != "") | "\(.name)@\(.version)"' "$PACKAGE/package.json" || true)

if [[ -z "$TAG_NAME" ]] || gh release list --json tagName --jq '.[].tagName' | grep -qx "$TAG_NAME"; then
  BASE_VERSION=$(gh release list --json tagName --jq "([.[] | select(.tagName | startswith(\"$PACKAGE@\")) | .tagName | sub(\"$PACKAGE@\"; \"\") | select(length > 0) | split(\".\") | map(tonumber)] | sort | last | if . == null then \"0.1.0\" else (map(tostring) | join(\".\")) end)")
  BASE_VERSION=${BASE_VERSION:-0.1.0}
  TAG_NAME=$PACKAGE@$BASE_VERSION
fi

ARCHIVE=docs/${TAG_NAME}.tgz
echo "📦 Publishing $PACKAGE as $TAG_NAME"

if pnpm run publish; then
  [[ -f "$ARCHIVE" ]] || { echo "❌ Archive $ARCHIVE not found"; exit 1; }
  echo "✅ Marking release $TAG_NAME as published"
  if gh release view "$TAG_NAME" > /dev/null 2>&1; then
    gh release edit "$TAG_NAME" --draft=false
  else
    echo "❌ Release $TAG_NAME does not exist, skipping edit."
  fi
else
  echo "❌ Failed to publish $PACKAGE"
  gh release delete "$TAG_NAME" --yes || true
  git push origin ":refs/tags/$TAG_NAME" || true
  exit 1
fi
