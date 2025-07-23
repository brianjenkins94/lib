#!/usr/bin/env bash

PACKAGE="$1"

TAG_NAME=$(jq --raw-output 'select(.version != null and .version != "") | "\(.name)@\(.version)"' "$PACKAGE/package.json" || true)

RELEASES=$(gh release list --json tagName)

if [[ -z "$TAG_NAME" ]] || jq --raw-output '.[].tagName' <<< "$RELEASES" | grep -qx "$TAG_NAME"; then
  TAG_NAME="${PACKAGE}@$(jq --raw-output '([.[] | select(.tagName | startswith("'"$PACKAGE"'@")) | .tagName | sub("'"$PACKAGE"'@";"") | select(length > 0) | split(".") | map(tonumber)] | sort | last | if . == null or . == [] then [0,1,0] else . end | map(tostring) | join("."))' <<< "$RELEASES")"
fi

echo "📦 Publishing $PACKAGE as $TAG_NAME"

if pnpm run publish; then
  if [[ ! -f "docs/${TAG_NAME}.tgz" ]]; then
    echo "❌ Archive $TAG_NAME not found"
    exit 1
  fi

  echo "✅ Marking release $TAG_NAME as published"
  if gh release view "$TAG_NAME" > /dev/null 2>&1; then
    gh release edit "$TAG_NAME" --draft=false
  else
    echo "❌ Release $TAG_NAME does not exist, skipping edit."
  fi
else
  echo "❌ Failed to publish $PACKAGE"
  exit 1
fi
